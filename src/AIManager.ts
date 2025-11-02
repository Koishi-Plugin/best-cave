import { Context, Logger, h } from 'koishi';
import { Config, CaveObject, StoredElement } from './index';
import { FileManager } from './FileManager';
import * as path from 'path';
import { requireAdmin } from './Utils';

/**
 * @interface CaveMetaObject
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
 * @description AI 管理器，是连接 AI 服务与回声洞功能的核心模块。
 */
export class AIManager {
  private http;
  private requestCount = 0;
  private rateLimitResetTime = 0;

  /**
   * @constructor
   * @description AIManager 类的构造函数，负责初始化依赖项，并向 Koishi 的数据库模型中注册 `cave_meta` 表。
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
   * @param {any} cave - 主 `cave` 命令的实例，用于在其下注册子命令。
   */
  public registerCommands(cave) {
    cave.subcommand('.ai', '分析回声洞', { hidden: true, authority: 4 })
      .usage('分析尚未分析的回声洞，补全回声洞记录。')
      .action(async ({ session }) => {
        if (requireAdmin(session, this.config)) return requireAdmin(session, this.config);
        try {
          const allCaves = await this.ctx.database.get('cave', { status: 'active' });
          const analyzedCaveIds = new Set((await this.ctx.database.get('cave_meta', {})).map(meta => meta.cave));
          const cavesToAnalyze = allCaves.filter(cave => !analyzedCaveIds.has(cave.id));
          if (cavesToAnalyze.length === 0) return '无需分析回声洞';
          await session.send(`开始分析 ${cavesToAnalyze.length} 个回声洞...`);
          let successCount = 0;
          let failedCount = 0;
          for (const [index, cave] of cavesToAnalyze.entries()) {
            this.logger.info(`[${index + 1}/${cavesToAnalyze.length}] 正在分析回声洞 (${cave.id})...`);
            try {
              await this.analyzeAndStore(cave);
              successCount++;
            } catch (error) {
              failedCount++;
              this.logger.error(`分析回声洞（${cave.id}）时出错:`, error);
            }
          }
          return `已分析 ${successCount} 个回声洞（失败 ${failedCount} 个）`;
        } catch (error) {
          this.logger.error('分析回声洞失败:', error);
          return `操作失败: ${error.message}`;
        }
      });

    cave.subcommand('.desc <id:posint>', '查询回声洞')
      .action(async ({ }, id) => {
        if (!id) return '请输入要查看的回声洞序号';
        try {
          const [meta] = await this.ctx.database.get('cave_meta', { cave: id });
          if (!meta) return `回声洞（${id}）尚未分析`;
          const report = [
            `回声洞（${id}）分析结果：`,
            `描述：${meta.description}`,
            `关键词：${meta.keywords.join(', ')}`,
            `综合评分：${meta.rating}/100`
          ];
          return h.text(report.join('\n'));
        } catch (error) {
          this.logger.error(`查询回声洞（${id}）失败:`, error);
          return '查询失败，请稍后再试';
        }
      });
  }

  /**
   * @description 对新提交的内容执行 AI 驱动的查重检查。
   * @param {StoredElement[]} newElements - 待检查的新内容的结构化数组（包含文本、图片等）。
   * @param {{ sourceUrl: string, fileName: string }[]} newMediaToSave - 伴随新内容提交的、需要从 URL 下载的媒体文件列表。
   * @param {{ fileName: string; buffer: Buffer }[]} [mediaBuffers] - （可选）已经加载到内存中的媒体文件 Buffer，可用于优化性能。
   * @returns {Promise<{ duplicate: boolean; id?: number }>} 一个包含查重结果的对象。
   */
  public async checkForDuplicates(newElements: StoredElement[], newMediaToSave: { sourceUrl: string, fileName: string }[], mediaBuffers?: { fileName: string; buffer: Buffer }[]): Promise<{ duplicate: boolean; id?: number }> {
    try {
      const newAnalysis = await this.getAnalysis(newElements, newMediaToSave, mediaBuffers);
      if (!newAnalysis || newAnalysis.keywords.length === 0) return { duplicate: false };
      const allMeta = await this.ctx.database.get('cave_meta', {});
      const potentialDuplicates = (await Promise.all(allMeta.map(async (meta) => {
        const setA = new Set(newAnalysis.keywords);
        const setB = new Set(meta.keywords);
        let similarity = 0;
        if (setA.size > 0 && setB.size > 0) {
            const intersection = new Set([...setA].filter(x => setB.has(x)));
            const union = new Set([...setA, ...setB]);
            similarity = intersection.size / union.size;
        }
        if (similarity * 100 >= 80) {
          const [cave] = await this.ctx.database.get('cave', { id: meta.cave });
          return cave;
        }
      }))).filter(Boolean);
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
   * @param {CaveObject} cave - 需要被分析的完整回声洞对象，包含 `id` 和 `elements`。
   * @param {{ fileName: string; buffer: Buffer }[]} [mediaBuffers] - （可选）与该回声洞相关的、已加载到内存的媒体文件 Buffer。
   * @returns {Promise<void>} 操作完成后 resolve 的 Promise。
   * @throws {Error} 如果在分析或数据库存储过程中发生错误，则会向上抛出异常。
   */
  public async analyzeAndStore(cave: CaveObject, mediaBuffers?: { fileName: string; buffer: Buffer }[]): Promise<void> {
    try {
      const result = await this.getAnalysis(cave.elements, undefined, mediaBuffers);
      if (result) {
        await this.ctx.database.upsert('cave_meta', [{
          cave: cave.id,
          ...result,
          rating: Math.max(0, Math.min(100, result.rating || 0)),
        }]);
      }
    } catch (error) {
      this.logger.error(`分析回声洞（${cave.id}）失败:`, error);
      throw error;
    }
  }

  /**
   * @description 准备并发送内容给 AI 模型以获取分析结果。
   * @param {StoredElement[]} elements - 内容的结构化元素数组。
   * @param {{ sourceUrl: string, fileName: string }[]} [mediaToSave] - （可选）需要从网络下载的媒体文件信息。
   * @param {{ fileName: string; buffer: Buffer }[]} [mediaBuffers] - （可选）已存在于内存中的媒体文件 Buffer。
   * @returns {Promise<Omit<CaveMetaObject, 'cave'>>} 返回一个不含 `cave` 字段的分析结果对象。如果内容为空或无法处理，则返回 `null`。
   */
  private async getAnalysis(elements: StoredElement[], mediaToSave?: { sourceUrl: string, fileName: string }[], mediaBuffers?: { fileName: string; buffer: Buffer }[]): Promise<Omit<CaveMetaObject, 'cave'>> {
    const userContent: any[] = [];
    const combinedText = elements.filter(el => el.type === 'text' && el.content).map(el => el.content as string).join('\n');
    if (combinedText.trim()) userContent.push({ type: 'text', text: combinedText });
    const mediaMap = new Map(mediaBuffers?.map(m => [m.fileName, m.buffer]));
    const imageElements = elements.filter(el => el.type === 'image' && el.file);
    for (const el of imageElements) {
      try {
        let buffer: Buffer;
        if (mediaMap.has(el.file)) {
          buffer = mediaMap.get(el.file);
        } else if (mediaToSave) {
          const item = mediaToSave.find(m => m.fileName === el.file);
          if (item) buffer = Buffer.from(await this.ctx.http.get(item.sourceUrl, { responseType: 'arraybuffer' }));
        } else {
          buffer = await this.fileManager.readFile(el.file);
        }
        if (buffer) {
          const mimeType = path.extname(el.file).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
          userContent.push({
            type: 'image_url',
            image_url: { url: `data:${mimeType};base64,${buffer.toString('base64')}` }
          });
        }
      } catch (error) {
        this.logger.warn(`分析内容（${el.file}）失败:`, error);
      }
    }
    if (userContent.length === 0) return null;
    const userMessage = { role: 'user', content: userContent };
    return await this.requestAI([userMessage], this.config.AnalysePrompt, this.config.aiAnalyseSchema);
  }

  /**
   * @description 封装了向 OpenAI 兼容的 API 发送请求的底层逻辑。
   * @param {any[]} messages - 要发送给 AI 的消息数组，格式遵循 OpenAI API 规范。
   * @param {string} systemPrompt - 指导 AI 行为的系统级提示词。
   * @param {string} schemaString - 一个 JSON 字符串，定义了期望 AI 返回的 JSON 对象的结构。
   * @returns {Promise<any>} AI 返回的、经过 JSON 解析的响应体。
   * @throws {Error} 当 JSON Schema 解析失败、网络请求失败或 AI 返回错误时，抛出异常。
   */
  private async requestAI(messages: any[], systemPrompt: string, schemaString: string): Promise<any> {
    const now = Date.now();
    if (now > this.rateLimitResetTime) {
      this.rateLimitResetTime = now + 60000;
      this.requestCount = 0;
    }
    if (this.requestCount >= this.config.aiTPM) {
      const delay = this.rateLimitResetTime - now;
      await new Promise(resolve => setTimeout(resolve, delay));
      this.rateLimitResetTime = Date.now() + 60000;
      this.requestCount = 0;
    }
    let schema = JSON.parse(schemaString);
    const payload = {
      model: this.config.aiModel,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      response_format: { type: 'json_schema', strict: true, schema },
    };
    const fullUrl = `${this.config.aiEndpoint.replace(/\/$/, '')}/chat/completions`;
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.config.aiApiKey}`
    };
    try {
      this.requestCount++;
      const response = await this.http.post(fullUrl, payload, { headers, timeout: 90000 });
      return JSON.parse(response.choices[0].message.content);
    } catch (error) {
      const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
      this.logger.error(`请求 API 失败: ${errorMessage}`);
      throw error;
    }
  }
}
