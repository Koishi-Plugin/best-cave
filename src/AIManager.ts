import { Context, Logger } from 'koishi';
import { Config, CaveObject, StoredElement } from './index';
import { FileManager } from './FileManager';
import * as path from 'path';
import { requireAdmin, DSU, generateFromLSH } from './Utils';

/**
 * @description 定义了数据库 `cave_meta` 表的结构模型。
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
 * @description AI 管理器，作为连接 AI 服务与回声洞功能的核心模块。
 */
export class AIManager {
  private http;

  private readonly ANALYSIS_SYSTEM_PROMPT = `你是一位专业的“数字人类学家”和“迷因（Meme）专家”，擅长分析解读网络社群“回声洞”（一种消息存档）中的内容。这些内容通常是笑话、网络梗、游戏截图、或有趣的引言。你的任务是分析用户提供的内容（可能包含文本和图片），并以严格的 JSON 格式返回分析结果。

请严格遵循以下规则和格式：

1.  **角色定位**：将自己视为熟悉网络流行文化、游戏、动漫和各类“梗”的专家。
2.  **语言要求**：\`keywords\` 和 \`description\` 的内容必须全部为中文。
3.  **分析与输出**：你的回复**必须且只能**是一个包裹在 \`\`\`json ... \`\`\` 代码块中的 JSON 对象，不包含任何解释性文字。该 JSON 对象必须包含以下三个键：

    *   \`"keywords"\` (字符串数组): 提取一组全面的中文标签 (tags)，这组标签的组合应能**精准地定义和分类**该内容，便于未来搜索。不需要限制数量，但追求准确和全面，应包含具体的人名、作品名、游戏名、事件名、或网络梗的专有名词。

    *   \`"description"\` (字符串): 用一句简洁的中文**概括内容的核心思想或解释其“梗”的来源和用法**。

    *   \`"rating"\` (0-100的整数): 根据以下**细化评分标准**进行综合评分：
        *   **创意与原创性 (0-10分)**：是否为原创或独特的二次创作？常见的截图或转发应酌情减分。
        *   **趣味性与信息量 (0-40分)**：内容是否有趣、引人发笑或包含有价值的信息？
        *   **文化价值与传播潜力 (0-30分)**：是否属于经典“梗”或具有成为新流行“梗”的潜力？
        *   **内容质量与清晰度 (0-20分)**：对于图片，是否清晰、无过多水印或压缩痕迹？对于文本，是否排版清晰、易于阅读？**图片模糊、带有严重水印应在此项大幅扣分**。`;

  private readonly DUPLICATE_CHECK_SYSTEM_PROMPT = `你是一位严谨的“网络文化内容查重专家”，尤其擅长识别网络梗、Copypasta（定型文）和笑话的变体。你的任务是比较用户提供的两段内容（content_a 和 content_b），判断它们在**语义上或作为“梗”的本质上是否表达了相同或高度相似的核心思想**。

请严格遵循以下规则：

1.  **重复的核心定义**：专注于核心含义，忽略无关紧要的格式、标点符号、错别字或语气差异。只要两段内容指向**同一个梗、同一个笑话、同一个句式模板或同一个核心事件**，就应视为重复。
2.  **常见的重复类型包括**：
    *   **文字变体**：用词略有不同，但表达完全相同的意思。
    *   **句式模板应用**：使用相同的“梗”句式，即使替换了其中的主体。
    *   **核心思想转述**：用不同的话复述了同一个意思或笑话。
    *   **跨语言相同梗**：同一个梗的不同语言或音译版本。
3.  **非重复的界定**：主题相似但**核心信息、笑点或结论不同**，则不应视为重复。
4.  **严格的JSON输出**：你的回复**必须且只能**是一个包裹在 \`\`\`json ... \`\`\` 代码块中的 JSON 对象。
5.  **唯一的输出键**：该 JSON 对象必须仅包含一个布尔类型的键 \`"duplicate"\`。如果内容重复或高度相似，值为 \`true\`，否则为 \`false\`。`;

  /**
   * @constructor
   * @param {Context} ctx - Koishi 的上下文对象，用于访问核心服务如数据库和 HTTP 客户端。
   * @param {Config} config - 插件的配置对象。
   * @param {Logger} logger - 日志记录器实例。
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
   * @description 注册所有与 AIManager 功能相关的 Koishi 命令，包括 AI 分析和内容比较。
   * @param {any} cave - 主命令的实例，用于挂载子命令。
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
          const totalToAnalyze = cavesToAnalyze.length;
          const progress = { count: 0 };
          const batchSize = 25;
          for (let i = 0; i < cavesToAnalyze.length; i += batchSize) {
            const batch = cavesToAnalyze.slice(i, i + batchSize);
            this.logger.info(`[${i + 1}/${cavesToAnalyze.length}] 正在分析 ${batch.length} 个回声洞...`);
            successCount += await this.processCaveBatch(batch, totalToAnalyze, progress);
          }

          const failedCount = totalToAnalyze - successCount;
          if (failedCount > 0) return `已分析 ${successCount} 个回声洞（失败 ${failedCount} 个）`;
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
          const candidatePairs = generateFromLSH(allMeta, (meta) => ({ id: meta.cave, keys: meta.keywords }));
          if (candidatePairs.size === 0) return '未发现相似内容';
          const allCaves = new Map((await this.ctx.database.get('cave', { status: 'active' })).map(c => [c.id, c]));
          const duplicatePairs: { id1: number; id2: number }[] = [];
          const comparisonPromises = Array.from(candidatePairs).map(async (pairKey) => {
            const [id1, id2] = pairKey.split('-').map(Number);
            const cave1 = allCaves.get(id1);
            const cave2 = allCaves.get(id2);
            if (cave1 && cave2 && await this.isContentDuplicateAI(cave1, cave2)) return { id1, id2 };
            return null;
          });
          const results = await Promise.all(comparisonPromises);
          duplicatePairs.push(...results.filter(Boolean));
          if (duplicatePairs.length === 0) return '未发现高重复性的内容';
          const dsu = new DSU();
          const allIds = new Set<number>();
          duplicatePairs.forEach(p => {
            dsu.union(p.id1, p.id2);
            allIds.add(p.id1);
            allIds.add(p.id2);
          });
          const clusters = new Map<number, number[]>();
          allIds.forEach(id => {
            const root = dsu.find(id);
            if (!clusters.has(root)) clusters.set(root, []);
            clusters.get(root)!.push(id);
          });
          const validClusters = Array.from(clusters.values()).filter(c => c.length > 1);
          if (validClusters.length === 0) return '未发现高重复性的内容';
          let report = `共发现 ${validClusters.length} 组高重复性的内容:`;
          validClusters.forEach(cluster => {
            const sortedCluster = cluster.sort((a, b) => a - b);
            report += `\n- ${sortedCluster.join('|')}`;
          });
          return report;
        } catch (error) {
          this.logger.error('检查重复性失败:', error);
          return `检查失败: ${error.message}`;
        }
      });
  }

  /**
   * @description 递归处理和分析回声洞批次，失败时按 1/5 拆分以定位问题。
   * @param {CaveObject[]} caves - 当前要处理的回声洞对象数组。
   * @param {number} totalCaves - 要分析的回声洞总数。
   * @param {{ count: number }} progress - 用于跟踪总体进度的计数器对象。
   * @returns {Promise<number>} 成功分析的回声洞数量。
   * @private
   */
  private async processCaveBatch(caves: CaveObject[], totalCaves: number, progress: { count: number }): Promise<number> {
    if (caves.length === 0) return 0;
    this.logger.info(`[${progress.count + 1}/${totalCaves}] 正在分析回声洞（${caves.map(c => c.id).join('|')}）...`);
    try {
      const analyses = await this.analyze(caves);
      if (analyses.length > 0) await this.ctx.database.upsert('cave_meta', analyses);
      progress.count += caves.length;
      return analyses.length;
    } catch (error) {
      if (caves.length > 1) {
        const subBatches: CaveObject[][] = [];
        const subBatchSize = Math.ceil(caves.length / 5);
        for (let i = 0; i < caves.length; i += subBatchSize) subBatches.push(caves.slice(i, i + subBatchSize));
        const processingPromises = subBatches.map(subBatch => this.processCaveBatch(subBatch, totalCaves, progress));
        const results = await Promise.all(processingPromises);
        return results.reduce((sum, count) => sum + count, 0);
      } else {
        const failedCave = caves[0];
        progress.count++;
        this.logger.error(`[${progress.count}/${totalCaves}] 分析回声洞（${failedCave.id}）失败:`, error);
        return 0;
      }
    }
  }

  /**
   * @description 对新提交的内容执行 AI 驱动的查重检查。
   * @param {StoredElement[]} newElements - 新提交的内容元素数组。
   * @param {{ fileName: string; buffer: Buffer }[]} [mediaBuffers] - (可选) 与内容关联的媒体文件缓存。
   * @returns {Promise<{ duplicate: boolean; ids?: number[] }>} 一个对象，包含查重结果和（如果重复）重复的回声洞 ID 数组。
   * @throws {Error} 当 AI 分析或比较过程中发生严重错误时抛出。
   */
  public async checkForDuplicates(newElements: StoredElement[], mediaBuffers?: { fileName: string; buffer: Buffer }[]): Promise<{ duplicate: boolean; ids?: number[] }> {
    try {
      const dummyCave: CaveObject = { id: 0, elements: newElements, channelId: '', userId: '', userName: '', status: 'preload', time: new Date() };
      const [newAnalysis] = await this.analyze([dummyCave], mediaBuffers);
      if (!newAnalysis?.keywords?.length) return { duplicate: false };
      const allMeta = await this.ctx.database.get('cave_meta', {}, { fields: ['cave', 'keywords'] });
      const similarCaveIds = allMeta
        .filter(meta => this.calculateKeywordSimilarity(newAnalysis.keywords, meta.keywords) >= 80)
        .map(meta => meta.cave);
      if (similarCaveIds.length === 0) return { duplicate: false };
      const potentialDuplicates = await this.ctx.database.get('cave', { id: { $in: similarCaveIds } });
      const comparisonPromises = potentialDuplicates.map(async (existingCave) => {
        if (await this.isContentDuplicateAI(dummyCave, existingCave)) return existingCave.id;
        return null;
      });
      const duplicateIds = (await Promise.all(comparisonPromises)).filter((id): id is number => id !== null);
      return { duplicate: duplicateIds.length > 0, ids: duplicateIds };
    } catch (error) {
      this.logger.error('查重回声洞出错:', error);
      return { duplicate: false };
    }
  }

  /**
   * @description 对单个或批量回声洞执行内容分析，提取关键词、生成描述并评分。
   * @param {CaveObject[]} caves - 需要分析的回声洞对象数组。
   * @param {{ fileName: string; buffer: Buffer }[]} [mediaBuffers] - (可选) 预加载的媒体文件缓存，以避免重复读取。
   * @returns {Promise<CaveMetaObject[]>} 一个 Promise，解析为包含分析结果的 `CaveMetaObject` 对象数组。
   */
  public async analyze(caves: CaveObject[], mediaBuffers?: { fileName: string; buffer: Buffer }[]): Promise<CaveMetaObject[]> {
    const mediaMap = mediaBuffers ? new Map(mediaBuffers.map(m => [m.fileName, m.buffer])) : undefined;
    const analysisPromises = caves.map(async (cave) => {
      const combinedText = cave.elements.filter(el => el.type === 'text' && el.content).map(el => el.content).join('\n');
      const imageElements = await Promise.all(
        cave.elements
          .filter(el => el.type === 'image' && el.file)
          .map(async (el) => {
            try {
              const buffer = mediaMap?.get(el.file) ?? await this.fileManager.readFile(el.file);
              const mimeType = path.extname(el.file).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
              return {
                type: 'image_url',
                image_url: { url: `data:${mimeType};base64,${buffer.toString('base64')}` },
              };
            } catch (error) {
              this.logger.warn(`读取文件（${el.file}）失败:`, error);
              return null;
            }
          })
      );
      const images = imageElements.filter(Boolean);
      if (!combinedText.trim() && images.length === 0) return null;
      const contentForAI: any[] = [];
      if (combinedText.trim()) contentForAI.push({ type: 'text', text: `请分析以下内容：\n\n${combinedText}` });
      contentForAI.push(...images);
      const userMessage = { role: 'user', content: contentForAI };
      const response = await this.requestAI<{ keywords: string[]; description: string; rating: number; }>([userMessage], this.ANALYSIS_SYSTEM_PROMPT);
      if (response) return {
          cave: cave.id,
          keywords: response.keywords || [],
          description: response.description || '',
          rating: Math.max(0, Math.min(100, response.rating || 0)),
        };
      return null;
    });
    const results = await Promise.all(analysisPromises);
    return results.filter((result): result is CaveMetaObject => !!result);
  }

  /**
   * @description 调用 AI 判断两个回声洞内容是否在语义上重复或高度相似。
   * @param {CaveObject} caveA - 第一个回声洞对象。
   * @param {CaveObject} caveB - 第二个回声洞对象。
   * @returns {Promise<boolean>} 如果内容被 AI 判断为重复，则返回 true，否则返回 false。
   * @throws {Error} 当 AI 请求失败时抛出。
   * @private
   */
  private async isContentDuplicateAI(caveA: CaveObject, caveB: CaveObject): Promise<boolean> {
    try {
      const formatContent = (elements: StoredElement[]) => elements.filter(el => el.type === 'text' && el.content).map(el => el.content).join(' ');
      const userMessageContent = {
          content_a: { id: caveA.id, text: formatContent(caveA.elements) },
          content_b: { id: caveB.id, text: formatContent(caveB.elements) },
      };
      const userMessage = { role: 'user', content: JSON.stringify(userMessageContent) };
      const response = await this.requestAI<{ duplicate?: boolean }>([userMessage], this.DUPLICATE_CHECK_SYSTEM_PROMPT);
      return response?.duplicate || false;
    } catch (error) {
      this.logger.error(`比较回声洞（${caveA.id}）与（${caveB.id}）失败:`, error);
      return false;
    }
  }

  /**
   * @description 计算两组关键词之间的 Jaccard 相似度。
   * Jaccard 相似度 = (交集大小 / 并集大小)。
   * @param {string[]} keywordsA -第一组关键词。
   * @param {string[]} keywordsB - 第二组关键词。
   * @returns {number} 返回 0 到 100 之间的相似度得分。
   * @private
   */
  private calculateKeywordSimilarity(keywordsA: string[], keywordsB: string[]): number {
    if (!keywordsA?.length || !keywordsB?.length) return 0;
    const setA = new Set(keywordsA);
    const setB = new Set(keywordsB);
    const intersection = new Set([...setA].filter(x => setB.has(x)));
    const union = new Set([...setA, ...setB]);
    return union.size > 0 ? (intersection.size / union.size) * 100 : 0;
  }

  /**
   * @description 封装了向 OpenAI 兼容的 API 发送请求的底层逻辑。
   * @template T - 期望从 AI 响应的 JSON 中解析出的数据类型。
   * @param {any[]} messages - 发送给 AI 的消息数组，通常包含用户消息。
   * @param {string} systemPrompt - 指导 AI 行为的系统级指令。
   * @returns {Promise<T>} 一个 Promise，解析为从 AI 响应中提取并解析的 JSON 对象。
   * @throws {Error} 当网络请求失败、AI 未返回有效内容或 JSON 解析失败时抛出。
   * @private
   */
  private async requestAI<T>(messages: any[], systemPrompt: string): Promise<T> {
    const payload = {
      model: this.config.aiModel,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
    };
    const fullUrl = `${this.config.aiEndpoint.replace(/\/$/, '')}/chat/completions`;
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.config.aiApiKey}`
    };
    try {
      const response = await this.http.post(fullUrl, payload, { headers, timeout: 600000 });
      const content: string = response?.choices?.[0]?.message?.content;
      if (!content?.trim()) throw new Error;
      const candidates: string[] = [];
      const jsonBlockMatch = content.match(/```json\s*([\s\S]*?)\s*```/i);
      if (jsonBlockMatch && jsonBlockMatch[1]) candidates.push(jsonBlockMatch[1]);
      candidates.push(content);
      const firstBrace = content.indexOf('{');
      const lastBrace = content.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace > firstBrace) candidates.push(content.substring(firstBrace, lastBrace + 1));
      for (const candidate of [...new Set(candidates)]) {
        try {
          return JSON.parse(candidate);
        } catch (parseError) { }
      }
      this.logger.error('解析失败', '原始响应:', JSON.stringify(response, null, 2));
      throw new Error;
    } catch (e) {
      throw e;
    }
  }
}
