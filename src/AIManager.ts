import { Context, Logger } from 'koishi';
import { Config, CaveObject, StoredElement } from './index';
import { FileManager } from './FileManager';
import * as path from 'path';
import { requireAdmin } from './Utils';

/**
 * @description 定义了数据库 `cave_meta` 表的结构模型。
 * @property {number} cave - 关联的回声洞 `id`，作为外键和主键。
 * @property {string[]} keywords - AI 从回声洞内容中提取的核心关键词数组。
 * @property {string} description - AI 生成的对回声洞内容的简洁摘要或描述。
 * @property {number} rating - AI 对内容质量、趣味性或相关性的综合评分，范围为 0 到 100。
 */
export interface CaveMetaObject {
  cave: number;
  keywords: string[];
  description: string;
  rating: number;
}

declare module 'koishi' {
  interface Tables {
    cave_meta: CaveMetaObject;
  }
}

/**
 * @class AIManager
 * @description AI 管理器，连接 AI 服务与回声洞功能的核心模块。
 */
export class AIManager {
  private http;
  private requestCount = 0;
  private rateLimitResetTime = 0;

  /**
   * @constructor
   * @param {Context} ctx - Koishi 的上下文对象，提供框架核心功能。
   * @param {Config} config - 插件的配置对象。
   * @param {Logger} logger - 日志记录器实例，用于输出日志。
   * @param {FileManager} fileManager - 文件管理器实例，用于处理媒体文件。
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
      keywords: 'json',
      description: 'text',
      rating: 'unsigned',
    }, {
      primary: 'cave',
    });
  }

  /**
   * @description 注册所有与 AIManager 功能相关的 Koishi 命令。
   * @param {any} cave - Koishi 命令实例，用于挂载子命令。
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
          let totalSuccessCount = 0;
          const batchSize = 10;
          for (let i = 0; i < cavesToAnalyze.length; i += batchSize) {
            const batch = cavesToAnalyze.slice(i, i + batchSize);
            this.logger.info(`[${i + 1}/${cavesToAnalyze.length}] 正在分析 ${batch.length} 条回声洞...`);
            const successCountInBatch = await this.analyzeAndStore(batch);
            totalSuccessCount += successCountInBatch;
          }
          return `已分析 ${totalSuccessCount} 个回声洞`;
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
          const allCaves = new Map((await this.ctx.database.get('cave', { status: 'active' })).map(c => [c.id, c]));
          const foundPairs = new Set<string>();
          const checkedPairs = new Set<string>();
          for (let i = 0; i < allMeta.length; i++) {
            for (let j = i + 1; j < allMeta.length; j++) {
              const meta1 = allMeta[i];
              const meta2 = allMeta[j];
              const pairKey = [meta1.cave, meta2.cave].sort((a, b) => a - b).join('-');
              if (checkedPairs.has(pairKey)) continue;
              const keywords1 = new Set(meta1.keywords);
              const keywords2 = new Set(meta2.keywords);
              const intersection = new Set([...keywords1].filter(x => keywords2.has(x)));
              const union = new Set([...keywords1, ...keywords2]);
              const similarity = union.size > 0 ? intersection.size / union.size : 0;
              if (similarity * 100 >= 80) {
                const cave1 = allCaves.get(meta1.cave);
                const cave2 = allCaves.get(meta2.cave);
                if (cave1 && cave2 && await this.isContentDuplicateAI(cave1, cave2)) foundPairs.add(`${cave1.id} & ${cave2.id}`);
                checkedPairs.add(pairKey);
              }
            }
          }
          if (foundPairs.size === 0) return '未发现高重复性的内容';
          let report = `已发现 ${foundPairs.size} 组高重复性的内容:\n`;
          report += [...foundPairs].join('\n');
          return report.trim();
        } catch (error) {
          this.logger.error('检查重复性失败:', error);
          return `检查失败: ${error.message}`;
        }
      });
  }

  /**
   * @description 对新提交的内容执行 AI 驱动的查重检查。
   * @param {StoredElement[]} newElements - 新提交的内容元素数组。
   * @param {{ fileName: string; buffer: Buffer }[]} [mediaBuffers] - 可选的媒体文件缓冲区数组。
   * @returns {Promise<{ duplicate: boolean; ids?: number[] }>} 一个 Promise，解析为一个对象，指示内容是否重复以及重复的回声洞 ID 数组（如果存在）。
   */
  public async checkForDuplicates(newElements: StoredElement[], mediaBuffers?: { fileName: string; buffer: Buffer }[]): Promise<{ duplicate: boolean; ids?: number[] }> {
    try {
      const dummyCave: CaveObject = { id: 0, elements: newElements, channelId: '', userId: '', userName: '', status: 'preload', time: new Date() };
      const [newAnalysis] = await this.getAnalyses([dummyCave], mediaBuffers ? new Map(mediaBuffers.map(m => [m.fileName, m.buffer])) : undefined);
      if (!newAnalysis?.keywords?.length) return { duplicate: false, ids: [] };
      const allMeta = await this.ctx.database.get('cave_meta', {}, { fields: ['cave', 'keywords'] });
      const newKeywordsSet = new Set(newAnalysis.keywords);
      const similarCaveIds = allMeta.filter(meta => {
        if (!meta.keywords?.length) return false;
        const existingKeywordsSet = new Set(meta.keywords);
        const intersection = new Set([...newKeywordsSet].filter(x => existingKeywordsSet.has(x)));
        const union = new Set([...newKeywordsSet, ...existingKeywordsSet]);
        const similarity = union.size > 0 ? intersection.size / union.size : 0;
        return similarity * 100 >= 80;
      }).map(meta => meta.cave);
      if (similarCaveIds.length === 0) return { duplicate: false, ids: [] };
      const potentialDuplicates = await this.ctx.database.get('cave', { id: { $in: similarCaveIds } });
      const duplicateIds: number[] = [];
      for (const existingCave of potentialDuplicates) if (await this.isContentDuplicateAI(dummyCave, existingCave)) duplicateIds.push(existingCave.id);
      return { duplicate: duplicateIds.length > 0, ids: duplicateIds };
    } catch (error) {
      this.logger.error('查重回声洞出错:', error);
      return { duplicate: false, ids: [] };
    }
  }

  /**
   * @description 对单个或批量回声洞执行完整的分析和存储流程。
   * @param {CaveObject[]} caves - 要分析的回声洞对象数组。
   * @param {{ fileName: string; buffer: Buffer }[]} [mediaBuffers] - 可选的媒体文件缓冲区数组，仅在分析新内容时使用。
   * @returns {Promise<number>} 一个 Promise，解析为成功分析和存储的条目数。
   */
  public async analyzeAndStore(caves: CaveObject[], mediaBuffers?: { fileName: string; buffer: Buffer }[]): Promise<number> {
    const mediaMap = mediaBuffers ? new Map(mediaBuffers.map(m => [m.fileName, m.buffer])) : undefined;
    const results = await this.getAnalyses(caves, mediaMap);
    if (!results?.length) return 0;
    const caveMetaObjects = results.map(res => ({
      cave: res.cave,
      keywords: res.keywords || [],
      description: res.description || '',
      rating: Math.max(0, Math.min(100, res.rating || 0)),
    }));
    await this.ctx.database.upsert('cave_meta', caveMetaObjects);
    return caveMetaObjects.length;
  }

  /**
   * @description 调用 AI 判断两个回声洞内容是否重复或高度相似。
   * @param {CaveObject} caveA - 第一个回声洞对象。
   * @param {CaveObject} caveB - 第二个回声洞对象。
   * @returns {Promise<boolean>} 如果内容相似则返回 true，否则返回 false。
   */
  private async isContentDuplicateAI(caveA: CaveObject, caveB: CaveObject): Promise<boolean> {
    try {
      const formatContent = (elements: StoredElement[]) => elements.filter(el => el.type === 'text' && el.content).map(el => el.content as string).join(' ');
      const userMessage = {
        role: 'user',
        content: JSON.stringify({
          content_a: { id: caveA.id, text: formatContent(caveA.elements) },
          content_b: { id: caveB.id, text: formatContent(caveB.elements) },
        })
      };
      const prompt = `你是一位内容查重专家。请判断 content_a 和 content_b 是否重复或高度相似。你的回复必须且只能是一个包裹在 \`\`\`json ... \`\`\` 代码块中的 JSON 对象，该对象仅包含一个键 "duplicate" (布尔值)。`;
      const response = await this.requestAI<{ duplicate?: boolean }>([userMessage], prompt);
      return response.duplicate || false;
    } catch (error) {
      this.logger.error(`比较回声洞（${caveA.id}）与（${caveB.id}）失败:`, error);
      return false;
    }
  }

  /**
   * @description 为一批回声洞准备内容，并向 AI 发送单个请求以获取所有分析结果。
   * @param {CaveObject[]} caves - 要分析的回声洞对象数组。
   * @param {Map<string, Buffer>} [mediaBufferMap] - 可选的媒体文件名到其缓冲区的映射。
   * @returns {Promise<CaveMetaObject[]>} 一个 Promise，解析为 AI 返回的分析结果数组。
   */
  private async getAnalyses(caves: CaveObject[], mediaBufferMap?: Map<string, Buffer>): Promise<CaveMetaObject[]> {
    const batchPayload = await Promise.all(caves.map(async (cave) => {
      const combinedText = cave.elements.filter(el => el.type === 'text' && el.content).map(el => el.content as string).join('\n');
      const imagesBase64 = (await Promise.all(cave.elements
        .filter(el => el.type === 'image' && el.file)
        .map(async (el) => {
          try {
            const buffer = mediaBufferMap?.get(el.file) ?? await this.fileManager.readFile(el.file);
            const mimeType = path.extname(el.file).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
            return `data:${mimeType};base64,${buffer.toString('base64')}`;
          } catch (error) {
            this.logger.warn(`读取文件（${el.file}）失败:`, error);
            return null;
          }
        })
      )).filter(Boolean);
      return { id: cave.id, text: combinedText, images: imagesBase64 };
    }));
    const nonEmptyPayloads = batchPayload.filter(p => p.text.trim() || p.images.length > 0);
    if (nonEmptyPayloads.length === 0) return [];
    const contentForAI = [];
    const textData = nonEmptyPayloads.map(({ id, text }) => ({ id, text }));
    contentForAI.push({ type: 'text', text: JSON.stringify(textData) });
    nonEmptyPayloads.forEach(payload => { payload.images.forEach(imageBase64Url => { contentForAI.push({ type: 'image_url', image_url: { url: imageBase64Url } }) }) });
    const userMessage = { role: 'user', content: contentForAI };
    const analysePrompt = `你是一位内容分析专家。请使用中文，分析我以JSON格式提供的一组内容（位于消息的第一个 text 部分），并结合可能附带的图片，为每一项内容总结关键词、概括内容并评分。你的回复必须且只能是一个包裹在 \`\`\`json ... \`\`\` 代码块中的有效 JSON 对象。该JSON对象应有一个 "analyses" 键，其值为一个数组。数组中的每个对象都必须包含 "id" (整数), "keywords" (字符串数组), "description" (字符串), 和 "rating" (0-100的整数)。`;
    const response = await this.requestAI<{ analyses?: { id: number; keywords: string[]; description: string; rating: number; }[] }>([userMessage], analysePrompt);
    return (response.analyses || []).map(res => ({
      cave: res.id,
      keywords: res.keywords,
      description: res.description,
      rating: res.rating
    }));
  }

  /**
   * @description 封装了向 OpenAI 兼容的 API 发送请求的底层逻辑，并稳健地解析 JSON 响应。
   * @param {any[]} messages - 发送给 AI 的消息数组，遵循 OpenAI 格式。
   * @param {string} systemPrompt - 系统提示词，用于指导 AI 的行为。
   * @returns {Promise<T>} 一个 Promise，解析为从 AI 接收到的、解析后的 JSON 对象。
   * @throws {Error} 当 AI 返回空或无效内容时抛出错误。
   */
  private async requestAI<T>(messages: any[], systemPrompt: string): Promise<T> {
    const now = Date.now();
    if (now > this.rateLimitResetTime) {
      this.rateLimitResetTime = now + 60000;
      this.requestCount = 0;
    }
    if (this.requestCount >= this.config.aiRPM) {
      const delay = this.rateLimitResetTime - now;
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
      this.rateLimitResetTime = Date.now() + 60000;
      this.requestCount = 0;
    }
    const payload = {
      model: this.config.aiModel,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
    };
    const fullUrl = `${this.config.aiEndpoint.replace(/\/$/, '')}/chat/completions`;
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.config.aiApiKey}`
    };
    this.requestCount++;
    const response = await this.http.post(fullUrl, payload, { headers, timeout: 90000 });
    const content = response?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      this.logger.error('原始响应:', JSON.stringify(response, null, 2));
      throw new Error('响应无效');
    }
    try {
      const jsonRegex = /```json\s*([\s\S]*?)\s*```/;
      const match = content.match(jsonRegex);
      let jsonString = '';
      if (match && match[1]) {
        jsonString = match[1];
      } else {
        jsonString = content;
      }
      return JSON.parse(jsonString);
    } catch (error) {
      this.logger.error('解析 JSON 失败:', error);
      throw new Error('解析失败');
    }
  }
}
