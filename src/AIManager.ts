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
            const successCountInBatch = await this.analyzeAndStoreBatch(batch);
            totalSuccessCount += successCountInBatch;
          }
          return `已分析 ${totalSuccessCount} 个回声洞`;
        } catch (error) {
          this.logger.error('分析回声洞失败:', error);
          return `操作失败: ${error.message}`;
        }
      });
  }

  /**
   * @description 对新提交的内容执行 AI 驱动的查重检查。
   * @param {StoredElement[]} newElements - 新提交的内容元素数组。
   * @param {{ fileName: string; buffer: Buffer }[]} [mediaBuffers] - 可选的媒体文件缓冲区数组。
   * @returns {Promise<{ duplicate: boolean; id?: number }>} 一个 Promise，解析为一个对象，指示内容是否重复以及重复的回声洞 ID（如果存在）。
   */
  public async checkForDuplicates(newElements: StoredElement[], mediaBuffers?: { fileName: string; buffer: Buffer }[]): Promise<{ duplicate: boolean; id?: number }> {
    try {
      const dummyCave: CaveObject = { id: 0, elements: newElements, channelId: '', userId: '', userName: '', status: 'preload', time: new Date() };
      const mediaMap = mediaBuffers ? new Map(mediaBuffers.map(m => [m.fileName, m.buffer])) : undefined;
      const [newAnalysis] = await this.getAnalyses([dummyCave], mediaMap);
      if (!newAnalysis?.keywords?.length) return { duplicate: false };
      const potentialDuplicates = await this.findPotentialDuplicates(newAnalysis.keywords);
      if (potentialDuplicates.length === 0) return { duplicate: false };
      const formatContent = (elements: StoredElement[]) => elements.filter(el => el.type === 'text').map(el => el.content as string).join(' ');
      const userMessage = {
        role: 'user',
        content: JSON.stringify({
          new_content: { text: formatContent(newElements) },
          existing_contents: potentialDuplicates.map(cave => ({ id: cave.id, text: formatContent(cave.elements) })),
        })
      };
      const response = await this.requestAI([userMessage], this.config.aiCheckPrompt, this.config.aiCheckSchema);
      return {
        duplicate: response.duplicate || false,
        id: response.id ? Number(response.id) : undefined,
      };
    } catch (error) {
      this.logger.error('查重回声洞出错:', error);
      return { duplicate: false };
    }
  }

  /**
   * @description 对单个回声洞对象执行完整的分析和存储流程。
   * @param {CaveObject} cave - 要分析的回声洞对象。
   * @param {{ fileName: string; buffer: Buffer }[]} [mediaBuffers] - 可选的媒体文件缓冲区数组，用于新提交内容的分析。
   * @returns {Promise<void>} 分析和存储操作完成后解析的 Promise。
   */
  public async analyzeAndStore(cave: CaveObject, mediaBuffers?: { fileName: string; buffer: Buffer }[]): Promise<void> {
    try {
      const mediaMap = mediaBuffers ? new Map(mediaBuffers.map(m => [m.fileName, m.buffer])) : undefined;
      const [result] = await this.getAnalyses([cave], mediaMap);
      if (result) {
        await this.ctx.database.upsert('cave_meta', [{
          cave: cave.id,
          keywords: result.keywords || [],
          description: result.description || '',
          rating: Math.max(0, Math.min(100, result.rating || 0)),
        }]);
      }
    } catch (error) {
      this.logger.error(`分析回声洞（${cave.id}）出错:`, error);
    }
  }

  /**
   * @description 对一批回声洞执行分析并存储结果。
   * @param {CaveObject[]} caves - 要分析的回声洞对象数组。
   * @returns {Promise<number>} 一个 Promise，解析为成功分析和存储的条目数。
   */
  private async analyzeAndStoreBatch(caves: CaveObject[]): Promise<number> {
    const results = await this.getAnalyses(caves);
    if (!results?.length) return 0;
    const caveMetaObjects = results.map(res => ({
      cave: res.id,
      keywords: res.keywords || [],
      description: res.description || '',
      rating: Math.max(0, Math.min(100, res.rating || 0)),
    }));
    await this.ctx.database.upsert('cave_meta', caveMetaObjects);
    return caveMetaObjects.length;
  }

  /**
   * @description 根据新内容的关键词，查找并返回可能重复的回声洞。
   * @param {string[]} newKeywords - 新内容的关键词数组。
   * @returns {Promise<CaveObject[]>} 一个 Promise，解析为可能重复的回声洞对象数组。
   */
  private async findPotentialDuplicates(newKeywords: string[]): Promise<CaveObject[]> {
    const allMeta = await this.ctx.database.get('cave_meta', {}, { fields: ['cave', 'keywords'] });
    const newKeywordsSet = new Set(newKeywords);
    const similarCaveIds = allMeta.filter(meta => {
      if (!meta.keywords?.length) return false;
      const existingKeywordsSet = new Set(meta.keywords);
      const intersection = new Set([...newKeywordsSet].filter(x => existingKeywordsSet.has(x)));
      const union = new Set([...newKeywordsSet, ...existingKeywordsSet]);
      const similarity = union.size > 0 ? intersection.size / union.size : 0;
      return similarity * 100 >= 80;
    }).map(meta => meta.cave);
    if (similarCaveIds.length === 0) return [];
    return this.ctx.database.get('cave', { id: { $in: similarCaveIds } });
  }

  /**
   * @description 为一批回声洞准备内容，并向 AI 发送单个请求以获取所有分析结果。
   * @param {CaveObject[]} caves - 要分析的回声洞对象数组。
   * @param {Map<string, Buffer>} [mediaBufferMap] - 可选的媒体文件名到其缓冲区的映射。
   * @returns {Promise<any[]>} 一个 Promise，解析为 AI 返回的分析结果数组。
   */
  private async getAnalyses(caves: CaveObject[], mediaBufferMap?: Map<string, Buffer>): Promise<any[]> {
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
    const nonEmptyPayload = batchPayload.filter(p => p.text.trim() || p.images.length > 0);
    if (nonEmptyPayload.length === 0) return [];
    const userMessage = { role: 'user', content: JSON.stringify(nonEmptyPayload) };
    const response = await this.requestAI([userMessage], this.config.AnalysePrompt, this.config.aiAnalyseSchema);
    return response.analyses || [];
  }

  /**
   * @description 确保请求不会超过设定的速率限制（RPM）。如果需要，会延迟执行。
   * @returns {Promise<void>} 当可以继续发送请求时解析的 Promise。
   */
  private async ensureRateLimit(): Promise<void> {
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
  }

  /**
   * @description 封装了向 OpenAI 兼容的 API 发送请求的底层逻辑。
   * @param {any[]} messages - 发送给 AI 的消息数组，遵循 OpenAI 格式。
   * @param {string} systemPrompt - 系统提示词，用于指导 AI 的行为。
   * @param {string} schemaString - 定义期望响应格式的 JSON Schema 字符串。
   * @returns {Promise<any>} 一个 Promise，解析为从 AI 接收到的、解析后的 JSON 对象。
   * @throws {Error} 当 AI 返回空或无效内容时抛出错误。
   */
  private async requestAI(messages: any[], systemPrompt: string, schemaString: string): Promise<any> {
    await this.ensureRateLimit();
    const payload = {
      model: this.config.aiModel,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'extract_data',
          description: '根据提供的内容提取或分析信息。',
          schema: JSON.parse(schemaString),
        },
      },
    };
    const fullUrl = `${this.config.aiEndpoint.replace(/\/$/, '')}/chat/completions`;
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.config.aiApiKey}`
    };
    this.requestCount++;
    const response = await this.http.post(fullUrl, payload, { headers, timeout: 90000 });
    const content = response.choices?.[0]?.message?.content;
    if (typeof content === 'string' && content.trim()) return JSON.parse(content);
    throw new Error('响应无效');
  }
}
