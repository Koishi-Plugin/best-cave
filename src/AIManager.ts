import { Context, Logger, h } from 'koishi';
import { Config, CaveObject, StoredElement } from './index';
import { FileManager } from './FileManager';
import * as path from 'path';
import { requireAdmin } from './Utils';

/**
 * @description 数据库 `cave_meta` 表的完整对象模型。
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
 * @description 负责 AI 分析（描述、评分、关键词）和 AI 查重。
 * 通过与外部 AI 服务接口交互，实现对回声洞内容的深度分析和重复性检查。
 */
export class AIManager {
  private http;

  /**
   * @constructor
   * @param {Context} ctx - Koishi 的上下文对象。
   * @param {Config} config - 插件的配置信息。
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
      keywords: 'json',
      description: 'text',
      rating: 'unsigned',
    }, {
      primary: 'cave',
    });
  }

  /**
   * @description 注册与 AI 功能相关的 `.ai` 子命令。
   * @param {any} cave - 主 `cave` 命令实例。
   */
  public registerCommands(cave) {
    cave.subcommand('.ai', '分析回声洞', { hidden: true, authority: 4 })
      .usage('分析尚未分析的回声洞，补全回声洞记录。')
      .action(async ({ session }) => {
        const adminError = requireAdmin(session, this.config);
        if (adminError) return adminError;

        try {
          const allCaves = await this.ctx.database.get('cave', { status: 'active' });
          const analyzedCaveIds = new Set((await this.ctx.database.get('cave_meta', {})).map(meta => meta.cave));
          const cavesToAnalyze = allCaves.filter(cave => !analyzedCaveIds.has(cave.id));
          if (cavesToAnalyze.length === 0) return '无需分析回声洞';
          await session.send(`开始分析 ${cavesToAnalyze.length} 个回声洞...`);
          let totalSuccessCount = 0;
          for (let i = 0; i < cavesToAnalyze.length; i += 5) {
            const batch = cavesToAnalyze.slice(i, i + 5);
            this.logger.info(`[${totalSuccessCount}/${cavesToAnalyze.length}] 正在分析 ${batch.length} 条回声洞...`);
            await Promise.all(batch.map(cave => this.analyzeAndStore(cave)));
            totalSuccessCount += batch.length;
          }
          return `已分析 ${totalSuccessCount} 个回声洞`;
        } catch (error) {
          this.logger.error('已中断分析回声洞:', error);
          return `分析回声洞失败：${error.message}`;
        }
      });

    cave.subcommand('.desc <id:posint>', '查询回声洞')
      .action(async ({}, id) => {
        if (!id) return '请输入要查看的回声洞序号';
        try {
          const [meta] = await this.ctx.database.get('cave_meta', { cave: id });
          if (!meta) return `回声洞（${id}）尚未分析`;
          const keywordsText = meta.keywords.join(', ');
          const report = [
            `回声洞（${id}）分析结果：`,
            `描述：${meta.description}`,
            `关键词：${keywordsText}`,
            `评分：${meta.rating}/100`
          ];
          return h.text(report.join('\n'));
        } catch (error) {
          this.logger.error(`查询回声洞（${id}）失败:`, error);
          return '查询失败，请稍后再试';
        }
      });
  }

  /**
   * @description 对新内容进行两阶段 AI 查重。
   * @param {StoredElement[]} newElements - 新内容的元素数组。
   * @param {{ sourceUrl: string, fileName: string }[]} newMediaToSave - 新内容中待上传的媒体文件信息。
   * @param {{ fileName: string; buffer: Buffer }[]} [mediaBuffers] - (可选) 已下载的媒体文件 Buffer。
   * @returns {Promise<{ duplicate: boolean; id?: number }>} - 返回 AI 判断结果。
   */
  public async checkForDuplicates(newElements: StoredElement[], newMediaToSave: { sourceUrl: string, fileName: string }[], mediaBuffers?: { fileName: string; buffer: Buffer }[]): Promise<{ duplicate: boolean; id?: number }> {
    try {
      const newAnalysis = await this.getAnalysis(newElements, newMediaToSave, mediaBuffers);
      if (!newAnalysis || newAnalysis.keywords.length === 0) return { duplicate: false };
      const newKeywords = new Set(newAnalysis.keywords);
      const allMeta = await this.ctx.database.get('cave_meta', {});
      const potentialDuplicates: CaveObject[] = [];
      for (const meta of allMeta) {
        const existingKeywords = new Set(meta.keywords);
        const similarity = this.calculateKeywordSimilarity(newKeywords, existingKeywords);
        if ((similarity * 100) >= 80) {
          const [cave] = await this.ctx.database.get('cave', { id: meta.cave });
          if (cave) potentialDuplicates.push(cave);
        }
      }
      if (potentialDuplicates.length === 0) return { duplicate: false };
      const { payload } = await this.prepareDedupePayload(newElements, potentialDuplicates);
      const fullUrl = `${this.config.aiEndpoint}/models/${this.config.aiModel}:generateContent?key=${this.config.aiApiKey}`;
      const response = await this.http.post(fullUrl, payload, { headers: { 'Content-Type': 'application/json' }, timeout: 90000 });
      return this.parseDedupeResponse(response);
    } catch (error) {
      this.logger.error('查重回声洞出错:', error);
      return { duplicate: false };
    }
  }

  /**
   * @description 分析单个回声洞，并将分析结果存入数据库。
   * @param {CaveObject} cave - 需要分析的回声洞对象。
   * @param {{ fileName: string; buffer: Buffer }[]} [mediaBuffers] - (可选) 已下载的媒体文件 Buffer。
   * @returns {Promise<void>}
   */
  public async analyzeAndStore(cave: CaveObject, mediaBuffers?: { fileName: string; buffer: Buffer }[]): Promise<void> {
    try {
      const analysisResult = await this.getAnalysis(cave.elements, undefined, mediaBuffers);
      if (analysisResult) await this.ctx.database.upsert('cave_meta', [{ cave: cave.id, ...analysisResult }]);
    } catch (error) {
      this.logger.error(`分析回声洞（${cave.id}）失败:`, error);
      throw error;
    }
  }

  /**
   * @description 调用 AI 模型获取内容的分析结果。
   * @param {StoredElement[]} elements - 内容的元素数组。
   * @param {{ sourceUrl: string, fileName: string }[]} [mediaToSave] - (可选) 待保存的媒体文件信息。
   * @param {{ fileName: string; buffer: Buffer }[]} [mediaBuffers] - (可选) 已下载的媒体文件 Buffer。
   * @returns {Promise<Omit<CaveMetaObject, 'cave'>>} - 返回分析结果对象。
   */
  private async getAnalysis(elements: StoredElement[], mediaToSave?: { sourceUrl: string, fileName: string }[], mediaBuffers?: { fileName: string; buffer: Buffer }[]): Promise<Omit<CaveMetaObject, 'cave'>> {
    const { payload } = await this.preparePayload(this.config.AnalysePrompt, this.config.aiAnalyseSchema, elements, mediaToSave, mediaBuffers);
    if (!payload.contents) return null;
    const fullUrl = `${this.config.aiEndpoint}/models/${this.config.aiModel}:generateContent?key=${this.config.aiApiKey}`;
    const response = await this.http.post(fullUrl, payload, { headers: { 'Content-Type': 'application/json' }, timeout: 60000 });
    return this.parseAnalysisResponse(response);
  }

  /**
   * @description 使用 Jaccard 相似度系数计算两组关键词的相似度。
   * @param {Set<string>} setA - 第一组关键词集合。
   * @param {Set<string>} setB - 第二组关键词集合。
   * @returns {number} - 返回 0 到 1 之间的相似度值。
   */
  private calculateKeywordSimilarity(setA: Set<string>, setB: Set<string>): number {
    const intersection = new Set([...setA].filter(x => setB.has(x)));
    const union = new Set([...setA, ...setB]);
    return union.size === 0 ? 0 : intersection.size / union.size;
  }

  /**
   * @description 准备发送给 AI 模型的请求体（Payload）。
   * @param {string} prompt - 系统提示词。
   * @param {string} schemaString - JSON Schema 字符串。
   * @param {StoredElement[]} elements - 内容的元素数组。
   * @param {{ sourceUrl: string, fileName: string }[]} [mediaToSave] - (可选) 待保存的媒体文件信息。
   * @param {{ fileName: string; buffer: Buffer }[]} [mediaBuffers] - (可选) 已下载的媒体文件 Buffer。
   * @returns {Promise<{ payload: any }>} - 返回包含请求体的对象。
   */
  private async preparePayload(prompt: string, schemaString: string, elements: StoredElement[], mediaToSave?: { sourceUrl: string, fileName: string }[], mediaBuffers?: { fileName: string; buffer: Buffer }[]): Promise<{ payload: any }> {
    const parts: any[] = [{ text: prompt }];
    const combinedText = elements.filter(el => el.type === 'text' && el.content).map(el => el.content as string).join('\n');
    if (combinedText) parts.push({ text: combinedText });
    const mediaMap = new Map(mediaBuffers?.map(m => [m.fileName, m.buffer]));
    const imageElements = elements.filter(el => el.type === 'image' && el.file);
    for (const el of imageElements) {
      try {
        let buffer: Buffer;
        if (mediaMap.has(el.file)) {
          buffer = mediaMap.get(el.file);
        } else if (mediaToSave) {
          const item = mediaToSave.find(m => m.fileName === el.file);
          if(item) buffer = Buffer.from(await this.ctx.http.get(item.sourceUrl, { responseType: 'arraybuffer' }));
        } else {
          buffer = await this.fileManager.readFile(el.file);
        }
        if (buffer) {
          const mimeType = path.extname(el.file).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
          parts.push({ inline_data: { mime_type: mimeType, data: buffer.toString('base64') } });
        }
      } catch (error) {
        this.logger.warn(`分析内容（${el.file}）失败:`, error);
      }
    }
    if (parts.length <= 1) return { payload: {} };
    try {
      const schema = JSON.parse(schemaString);
      return { payload: { contents: [{ parts }], generationConfig: { response_schema: schema } } };
    } catch (error) {
      this.logger.error('解析JSON Schema失败:', error);
      return { payload: {} };
    }
  }

  /**
   * @description 准备用于 AI 精准查重的请求体（Payload）。
   * @param {StoredElement[]} newElements - 新内容的元素。
   * @param {CaveObject[]} existingCaves - 经过初筛的疑似重复的旧内容。
   * @returns {Promise<{ payload: any }>} - 返回适用于查重场景的请求体。
   */
  private async prepareDedupePayload(newElements: StoredElement[], existingCaves: CaveObject[]): Promise<{ payload: any }> {
    const formatContent = (elements: StoredElement[]) => elements.filter(el => el.type === 'text').map(el => el.content as string).join(' ');
    const payloadContent = JSON.stringify({
      new_content: { text: formatContent(newElements) },
      existing_contents: existingCaves.map(cave => ({ id: cave.id, text: formatContent(cave.elements) })),
    });
    const fullPrompt = `${this.config.aiCheckPrompt}\n\n以下是需要处理的数据:\n${payloadContent}`;
    try {
      const schema = JSON.parse(this.config.aiCheckSchema);
      return { payload: { contents: [{ parts: [{ text: fullPrompt }] }], generationConfig: { response_schema: schema } } };
    } catch (error) {
      this.logger.error('解析查重JSON Schema失败:', error);
      return { payload: {} };
    }
  }

  /**
   * @description 解析 AI 返回的分析响应。
   * @param {any} response - AI 服务的原始响应对象。
   * @returns {Omit<CaveMetaObject, 'cave'>} - 返回结构化的分析结果。
   */
  private parseAnalysisResponse(response: any): Omit<CaveMetaObject, 'cave'> {
    try {
      const content = response.candidates[0].content.parts[0].text;
      const parsed = JSON.parse(content);
      const keywords = Array.isArray(parsed.keywords) ? parsed.keywords : [];
      return {
        keywords,
        description: parsed.description || '无',
        rating: Math.max(0, Math.min(100, parsed.rating || 0)),
      };
    } catch (error) {
      this.logger.error('分析响应解析失败:', error, '原始响应:', JSON.stringify(response));
      return { keywords: [], description: '解析失败', rating: 0 };
    }
  }

  /**
   * @description 解析 AI 返回的查重响应。
   * @param {any} response - AI 服务的原始响应对象。
   * @returns {{ duplicate: boolean; id?: number }} - 返回查重结果。
   */
  private parseDedupeResponse(response: any): { duplicate: boolean; id?: number } {
    try {
      const content = response.candidates[0].content.parts[0].text;
      const parsed = JSON.parse(content);
      if (parsed.duplicate === true && parsed.id) return { duplicate: true, id: Number(parsed.id) };
      return { duplicate: false };
    } catch (error)
    {
      this.logger.error('查重响应解析失败:', error, '原始响应:', JSON.stringify(response));
      return { duplicate: false };
    }
  }
}
