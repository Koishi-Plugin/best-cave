import { Context, Logger } from 'koishi';
import { Config, CaveObject, StoredElement } from './index';
import { FileManager } from './FileManager';
import * as path from 'path';
import { requireAdmin, DSU, generateFromLSH } from './Utils';

/**
 * @description 定义了数据库 \`cave_meta\` 表的结构模型。
 */
export interface CaveMetaObject {
  cave: number;
  rating: number;
  type: string;
  keywords: string[];
}

declare module 'koishi' {
  interface Tables {
    cave_meta: CaveMetaObject;
  }
}

/**
 * @class AIManager
 * @description AI 管理器，作为连接 AI 服务与回声洞功能的核心模块。
 */
export class AIManager {
  private http;
  private endpointIndex = 0;
  private retryTime = 0;

  /**
   * @description 用于分析的 AI 系统提示词。
   */
  private readonly ANALYSIS_SYSTEM_PROMPT = `你需要分析给定的内容，并按照以下规则进行评分、分类和提取内容中的关键词。
你的回复必须且只能是一个JSON对象，禁止含有解释说明等其他文字，只包含rating、type和keywords，例如{"rating": 88,"type": "Game","keywords": ["Minecraft", "Nether"]}。`;

  /**
   * @description 用于查重的 AI 系统提示词。
   */
  private readonly DUPLICATE_SYSTEM_PROMPT = `你需要比较给定的“新内容”与“候选内容”，识别内容语义或核心思想重复的候选内容。
你的回复必须且只能是一个JSON数组，禁止含有解释说明等其他文字，只包含重复项ID，例如[1, 2]，若无重复，则返回[]。`;

  /**
   * @constructor
   * @description AIManager 的构造函数。
   * @param {Context} ctx - Koishi 的上下文对象。
   * @param {Config} config - 插件的配置对象。
   * @param {Logger} logger - 日志记录器实例。
   * @param {FileManager} fileManager - 文件管理器实例。
   */
  constructor(
    private ctx: Context,
    private config: Config,
    private logger: Logger,
    private fileManager: FileManager,
  ) {
    this.http = ctx.http;
    this.ctx.model.extend('cave_meta', {
      cave: 'unsigned',
      rating: 'unsigned',
      type: 'string',
      keywords: 'json',
    }, {
      primary: 'cave',
    });
  }

  /**
   * @description 注册与 AI 功能相关的管理命令。
   * @param {any} cave - \`cave\` 命令的实例，用于挂载子命令。
   */
  public registerCommands(cave) {
    cave.subcommand('.ai', '分析回声洞', { hidden: true, authority: 4 })
      .usage('分析尚未分析的回声洞，补全回声洞记录。')
      .action(async ({ session }) => {
        if (requireAdmin(session, this.config)) return requireAdmin(session, this.config);
        try {
          const allCaves = await this.ctx.database.get('cave', { status: 'active' });
          const analyzedCaveIds = new Set((await this.ctx.database.get('cave_meta', {}, { fields: ['cave'] })).map(meta => meta.cave));
          const cavesToAnalyze = allCaves.filter(cave => !analyzedCaveIds.has(cave.id));
          if (cavesToAnalyze.length === 0) return '无需分析回声洞';
          await session.send(`开始分析 ${cavesToAnalyze.length} 个回声洞...`);
          let successCount = 0;
          let failedCount = 0;
          for (let i = 0; i < cavesToAnalyze.length; i += 20) {
            const batch = cavesToAnalyze.slice(i, i + 20);
            this.logger.info(`[${i + 1}/${cavesToAnalyze.length}] 正在分析 ${batch.length} 个回声洞...`);
            const results = await Promise.allSettled(batch.map(cave => this.analyze([cave])));
            const successfulAnalyses: CaveMetaObject[] = [];
            for (let j = 0; j < results.length; j++) {
              const result = results[j];
              if (result.status === 'fulfilled' && result.value.length > 0) {
                successfulAnalyses.push(result.value[0]);
              } else {
                failedCount++;
                if (result.status === 'rejected') this.logger.error(`分析回声洞（${batch[j].id}）失败:`, result.reason);
              }
            }
            if (successfulAnalyses.length > 0) {
              await this.ctx.database.upsert('cave_meta', successfulAnalyses);
              successCount += successfulAnalyses.length;
            }
          }
          return `已分析 ${successCount} 个回声洞（失败 ${failedCount} 个）`;
        } catch (error) {
          this.logger.error('分析回声洞失败:', error);
          return `操作失败: ${error.message}`;
        }
      });

    cave.subcommand('.compare', '比较重复性', { hidden: true })
      .usage('检查回声洞，找出可能重复的内容。')
      .action(async ({ session }) => {
        if (requireAdmin(session, this.config)) return requireAdmin(session, this.config);
        await session.send('正在检查，请稍候...');
        try {
          const allMeta = await this.ctx.database.get('cave_meta', {});
          if (allMeta.length < 2) return '无可比较数据';
          const combinedTags = (meta: CaveMetaObject) => [meta.type, ...(meta.keywords || [])].filter(Boolean);
          const candidatePairs = generateFromLSH(allMeta, (meta) => ({ id: meta.cave, keys: combinedTags(meta) }));
          if (candidatePairs.size === 0) return '未发现相似内容';
          const groupedCandidates = new Map<number, Set<number>>();
          const allCaveIds = new Set<number>();
          candidatePairs.forEach(pairKey => {
            const [id1, id2] = pairKey.split('-').map(Number);
            if (!groupedCandidates.has(id1)) groupedCandidates.set(id1, new Set());
            groupedCandidates.get(id1)!.add(id2);
            allCaveIds.add(id1);
            allCaveIds.add(id2);
          });
          const caveData = await this.ctx.database.get('cave', { id: { $in: Array.from(allCaveIds) }, status: 'active' });
          const allCaves = new Map(caveData.map(c => [c.id, c]));
          const duplicatePairs: { id1: number; id2: number }[] = [];
          for (const [mainId, candidateIdsSet] of groupedCandidates.entries()) {
            const mainCave = allCaves.get(mainId);
            const candidateCaves = Array.from(candidateIdsSet).map(id => allCaves.get(id)).filter((c): c is CaveObject => !!c);
            if (mainCave && candidateCaves.length > 0) {
              const duplicateIds = await this.IsDuplicate(mainCave, candidateCaves);
              if (duplicateIds && duplicateIds.length > 0) duplicateIds.forEach(candidateId => duplicatePairs.push({ id1: mainId, id2: candidateId }));
            }
          }
          if (duplicatePairs.length === 0) return '未发现高重复性的内容';
          const dsu = new DSU();
          const finalIds = new Set<number>();
          duplicatePairs.forEach(p => {
            dsu.union(p.id1, p.id2);
            finalIds.add(p.id1);
            finalIds.add(p.id2);
          });
          const clusters = new Map<number, number[]>();
          finalIds.forEach(id => {
            const root = dsu.find(id);
            if (!clusters.has(root)) clusters.set(root, []);
            clusters.get(root)!.push(id);
          });
          const validClusters = Array.from(clusters.values()).filter(c => c.length > 1);
          if (validClusters.length === 0) return '未发现高重复性的内容';
          let report = `共发现 ${validClusters.length} 组高重复性的内容:`;
          validClusters.forEach(cluster => { report += `\n- ${cluster.sort((a, b) => a - b).join('|')}` });
          return report;
        } catch (error) {
          this.logger.error('检查重复性失败:', error);
          return `检查失败: ${error.message}`;
        }
      });
  }

  /**
   * @description 检查新内容是否与数据库中已存在的回声洞重复。
   * @param {CaveMetaObject} newAnalysis - 新内容经过 AI 分析后的元数据。
   * @param {CaveObject} newCave - 待检查的新回声洞的完整对象。
   * @returns {Promise<number[]>} - 一个 Promise，解析为重复的回声洞 ID 数组。如果不重复或检查失败，则为空数组。
   */
  public async checkForDuplicates(newAnalysis: CaveMetaObject, newCave: CaveObject): Promise<number[]> {
    try {
      if (!newAnalysis || !newAnalysis.type) return [];
      const allNewTags = [newAnalysis.type, ...(newAnalysis.keywords || [])];
      if (allNewTags.length === 1 && !allNewTags[0]) return [];
      const allMeta = await this.ctx.database.get('cave_meta', { type: newAnalysis.type }, { fields: ['cave', 'type', 'keywords'] });
      const similarCaveIds = allMeta
        .filter(meta => {
            const existingTags = [meta.type, ...(meta.keywords || [])];
            return this.calculateSimilarity(allNewTags, existingTags) >= 80;
        })
        .map(meta => meta.cave);
      if (similarCaveIds.length === 0) return [];
      const potentialDuplicates = await this.ctx.database.get('cave', { id: { $in: similarCaveIds } });
      if (potentialDuplicates.length === 0) return [];
      return await this.IsDuplicate(newCave, potentialDuplicates);
    } catch (error) {
      this.logger.error('查重回声洞出错:', error);
      return [];
    }
  }

  /**
   * @description 对一个或多个回声洞内容进行 AI 分析。
   * @param {CaveObject[]} caves - 需要分析的回声洞对象数组。
   * @param {{ fileName: string; buffer: Buffer }[]} [mediaBuffers] - 可选的媒体文件缓存。
   * @returns {Promise<CaveMetaObject[]>} - 一个 Promise，解析为分析结果（\`CaveMetaObject\`）的数组。
   */
  public async analyze(caves: CaveObject[], mediaBuffers?: { fileName: string; buffer: Buffer }[]): Promise<CaveMetaObject[]> {
    const analysisPromises = caves.map(async (cave) => {
      try {
        const contentForAI = await this.prepareContent(cave, mediaBuffers ? new Map(mediaBuffers.map(m => [m.fileName, m.buffer])) : undefined);
        if (!contentForAI) return null;
        const userMessage = { role: 'user', content: contentForAI };
        const response = await this.requestAI<{ rating: number; type: string; keywords: string[]; }>([userMessage], `${this.ANALYSIS_SYSTEM_PROMPT}\n${this.config.systemPrompt}`);
        if (response) {
          return {
            cave: cave.id, rating: Math.max(0, Math.min(100, response.rating || 0)),
            type: response.type || '', keywords: response.keywords || [],
          };
        }
        return null;
      } catch (error) {
        this.logger.error(`分析回声洞（${cave.id}）失败:`, error);
        return null;
      }
    });
    const results = await Promise.all(analysisPromises);
    return results.filter((result): result is CaveMetaObject => !!result);
  }

  /**
   * @description 准备单个回声洞的内容（文本和图片）以供 AI 模型处理。
   * @param {CaveObject} cave - 要处理的回声洞对象。
   * @param {Map<string, Buffer>} [mediaMap] - 媒体文件的缓存 Map。
   * @returns {Promise<any[] | null>} - 一个 Promise，解析为适合 AI 请求的 content 数组，如果回声洞为空则返回 null。
   */
  private async prepareContent(cave: CaveObject, mediaMap?: Map<string, Buffer>): Promise<any[] | null> {
    const combinedText = cave.elements.filter(el => el.type === 'text' && el.content).map(el => el.content as string).join('\n');
    const imageElements = await Promise.all(
      cave.elements
        .filter(el => el.type === 'image' && el.file)
        .map(async (el) => {
          try {
            const buffer = mediaMap?.get(el.file!) ?? await this.fileManager.readFile(el.file!);
            const mimeType = path.extname(el.file!).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
            return { type: 'image_url', image_url: { url: `data:${mimeType};base64,${buffer.toString('base64')}` } };
          } catch (error) {
            this.logger.warn(`读取文件（${el.file}）失败:`, error);
            return null;
          }
        })
    );
    const images = imageElements.filter(Boolean);
    if (!combinedText.trim() && images.length === 0) return null;
    const contentForAI: any[] = [];
    if (combinedText.trim()) contentForAI.push({ type: 'text', text: `${combinedText}` });
    contentForAI.push(...images);
    return contentForAI;
  }

  /**
   * @description 使用 AI 批量判断一个主要回声洞是否与一组候选回声洞中的任何一个重复。
   * @param {CaveObject} mainCave - 主要的回声洞。
   * @param {CaveObject[]} candidateCaves - 用于比较的候选回声洞数组。
   * @returns {Promise<number[]>} - 一个 Promise，解析为重复的回声洞 ID 数组。如果不重复或检查失败，则为空数组。
   */
  private async IsDuplicate(mainCave: CaveObject, candidateCaves: CaveObject[]): Promise<number[]> {
    try {
      const formatContent = (elements: StoredElement[]) => elements.filter(el => el.type === 'text' && el.content).map(el => el.content as string).join(' ');
      const newContentText = formatContent(mainCave.elements);
      const candidatesText = candidateCaves.map(cave => `{"id": ${cave.id}, "text": "${formatContent(cave.elements).replace(/"/g, '\\"')}"}`).join('\n');
      const userMessageContent = `新内容:\n${newContentText}\n候选内容:\n${candidatesText}`;
      const userMessage = { role: 'user', content: JSON.stringify(userMessageContent) };
      const response = await this.requestAI<number[]>([userMessage], this.DUPLICATE_SYSTEM_PROMPT);
      return response || [];
    } catch (error) {
      this.logger.error(`比较回声洞（${mainCave.id}）失败:`, error);
      return [];
    }
  }

  /**
   * @description 计算两组关键词之间的相似度（Jaccard 相似系数）。
   * @param {string[]} keywordsA - 第一组关键词。
   * @param {string[]} keywordsB - 第二组关键词。
   * @returns {number} - 返回 0 到 100 之间的相似度百分比。
   */
  private calculateSimilarity(keywordsA: string[], keywordsB: string[]): number {
    if (!keywordsA?.length || !keywordsB?.length) return 0;
    const setA = new Set(keywordsA);
    const setB = new Set(keywordsB);
    const intersection = new Set([...setA].filter(x => setB.has(x)));
    const union = new Set([...setA, ...setB]);
    return union.size > 0 ? (intersection.size / union.size) * 100 : 0;
  }

  /**
   * @description 向配置的 AI 服务端点发送请求的通用方法。
   * @template T - 期望从 AI 响应中解析出的 JSON 对象的类型。
   * @param {any[]} messages - 发送给 AI 的消息数组。
   * @param {string} systemPrompt - 系统提示词。
   * @returns {Promise<T>} - 一个 Promise，解析为从 AI 响应中解析出的 JSON 对象。
   * @throws {Error} - 如果 AI 服务持续失败或响应无法解析，则抛出错误。
   */
  private async requestAI<T>(messages: any[], systemPrompt: string): Promise<T> {
    const now = Date.now();
    if (now < this.retryTime) {
      const waitTime = this.retryTime - now;
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    const endpointConfig = this.config.endpoints[this.endpointIndex];
    this.endpointIndex = (this.endpointIndex + 1) % this.config.endpoints.length;
    const payload = { model: endpointConfig.model, messages: [{ role: 'system', content: systemPrompt }, ...messages] };
    const fullUrl = `${endpointConfig.url.replace(/\/$/, '')}/chat/completions`;
    const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${endpointConfig.key}` };
    let response;
    try {
      response = await this.http.post(fullUrl, payload, { headers, timeout: 600000 });
    } catch (httpError) {
      this.retryTime = Date.now() + 30000;
      this.logger.error(`请求失败:`, httpError);
      throw httpError;
    }
    try {
      const content: string = response?.choices?.[0]?.message?.content;
      if (!content?.trim()) throw new Error;
      const potentialStrings = new Set<string>();
      const jsonBlockMatch = content.match(/```json\s*([\s\S]*?)\s*```/i);
      if (jsonBlockMatch?.[1]) potentialStrings.add(jsonBlockMatch[1]);
      const firstBrace = content.indexOf('{');
      const lastBrace = content.lastIndexOf('}');
      const firstBracket = content.indexOf('[');
      const lastBracket = content.lastIndexOf(']');
      if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
        if (lastBrace > firstBrace) potentialStrings.add(content.substring(firstBrace, lastBrace + 1));
      } else if (firstBracket !== -1) {
        if (lastBracket > firstBracket) potentialStrings.add(content.substring(firstBracket, lastBracket + 1));
      }
      potentialStrings.add(content);
      for (const jsonString of potentialStrings) {
        try {
          const result = JSON.parse(jsonString);
          this.retryTime = 0;
          return result;
        } catch (e) { /* 忽略解析错误 */ }
      }
      throw new Error;
    } catch (parsingError) {
      this.logger.error('解析失败:', JSON.stringify(response, null, 2));
      throw parsingError;
    }
  }
}
