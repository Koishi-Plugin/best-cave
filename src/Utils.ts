import { Context, h, Logger, Session } from 'koishi';
import * as path from 'path';
import { CaveObject, Config, StoredElement, ForwardNode } from './index';
import { FileManager } from './FileManager';
import { HashManager, CaveHashObject } from './HashManager';
import { AIManager, CaveMetaObject } from './AIManager';
import { PendManager } from './PendManager';

const mimeTypeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.webp': 'image/webp' };

/**
 * @description 构建一条用于发送的完整回声洞消息，处理不同存储后端的资源链接。
 * @param cave 回声洞对象。
 * @param config 插件配置。
 * @param fileManager 文件管理器实例。
 * @param logger 日志记录器实例。
 * @param platform 目标平台名称 (e.g., 'onebot')。
 * @param prefix 可选的消息前缀 (e.g., '已删除', '待审核')。
 * @returns 包含多条消息的数组，每条消息是一个 (string | h)[] 数组。
 */
export async function buildCaveMessage(cave: CaveObject, config: Config, fileManager: FileManager, logger: Logger, platform?: string, prefix?: string): Promise<(string | h)[][]> {
  async function transformToH(elements: StoredElement[]): Promise<h[]> {
    return Promise.all(elements.map(async (el): Promise<h | h[]> => {
      if (el.type === 'text') return h.text(el.content as string);
      if (el.type === 'at') return h('at', { id: el.content as string });
      if (el.type === 'reply') return h('reply', { id: el.content as string });
      if (el.type === 'face') return h('face', { id: el.content as string });
      if (el.type === 'forward') {
        try {
          const forwardNodes: ForwardNode[] = Array.isArray(el.content) ? el.content : [];
          const messageNodes = await Promise.all(forwardNodes.map(async (node) => {
            const author = h('author', { id: node.userId, name: node.userName });
            const contentElements = await transformToH(node.elements);
            const unwrappedContent: h[] = [];
            const nestedMessageNodes: h[] = [];
            for (const contentEl of contentElements) {
              if (contentEl.type === 'message' && contentEl.attrs.forward) {
                nestedMessageNodes.push(...contentEl.children);
              } else {
                unwrappedContent.push(contentEl);
              }
            }
            const resultNodes: h[] = [];
            if (unwrappedContent.length > 0) resultNodes.push(h('message', {}, [author, ...unwrappedContent]));
            resultNodes.push(...nestedMessageNodes);
            return resultNodes;
          }));
          return h('message', { forward: true }, messageNodes.flat());
        } catch (error) {
          logger.warn(`解析回声洞（${cave.id}）合并转发内容失败:`, error);
          return h.text('[合并转发]');
        }
      }
      if (['image', 'video', 'audio', 'file'].includes(el.type)) {
        const fileName = el.file;
        if (!fileName) return h('p', {}, `[${el.type}]`);
        if (config.enableS3 && config.publicUrl) return h(el.type, { ...el, src: new URL(fileName, config.publicUrl).href });
        if (config.localPath) return h(el.type, { ...el, src: `file://${path.join(config.localPath, fileName)}` });
        try {
          const data = await fileManager.readFile(fileName);
          const mimeType = mimeTypeMap[path.extname(fileName).toLowerCase()] || 'application/octet-stream';
          return h(el.type, { ...el, src: `data:${mimeType};base64,${data.toString('base64')}` });
        } catch (error) {
          logger.warn(`转换文件 ${fileName} 为 Base64 失败:`, error);
          return h('p', {}, `[${el.type}]`);
        }
      }
      return null;
    })).then(hElements => hElements.flat().filter(Boolean));
  }
  const caveHElements = await transformToH(cave.elements);
  const data = {
    id: cave.id.toString(),
    name: cave.userName,
    user: cave.userId,
    channel: cave.channelId,
    time: cave.time.toLocaleString(),
  };
  const placeholderRegex = /\{([^}]+)\}/g;
  const replacer = (match: string, rawContent: string): string => {
    const isReviewMode = !!prefix;
    const [normalPart, reviewPart] = rawContent.split('/', 2);
    const contentToProcess = isReviewMode
      ? (reviewPart !== undefined ? reviewPart : normalPart)
      : normalPart;
    if (!contentToProcess?.trim()) return '';
    const useMask = contentToProcess.startsWith('*');
    const key = (useMask ? contentToProcess.substring(1) : contentToProcess).trim();
    if (!key) return '';
    const originalValue = data[key];
    if (originalValue === undefined || originalValue === null) return match;
    const valueStr = String(originalValue);
    if (!useMask) return valueStr;
    const len = valueStr.length;
    if (len <= 5) return valueStr;
    let keep = 0;
    if (len <= 7) keep = 2;
    else keep = 3;
    return `${valueStr.substring(0, keep)}***${valueStr.substring(len - keep)}`;
  };
  const [rawHeader, rawFooter] = config.caveFormat.split('|', 2);
  let header = rawHeader ? rawHeader.replace(placeholderRegex, replacer).trim() : '';
  if (prefix) header = `${prefix}${header}`;
  const footer = rawFooter ? rawFooter.replace(placeholderRegex, replacer).trim() : '';
  const problematicTypes = ['video', 'audio', 'file', 'forward'];
  const placeholderMap = { video: '[视频]', audio: '[音频]', file: '[文件]', forward: '[合并转发]' };
  const containsProblematic = platform === 'onebot' && caveHElements.some(el => problematicTypes.includes(el.type) || (el.type === 'message' && el.attrs.forward));
  if (!containsProblematic) {
    const finalMessage: (string | h)[] = [];
    if (header) finalMessage.push(header + '\n');
    finalMessage.push(...caveHElements);
    if (footer) finalMessage.push('\n' + footer);
    return [finalMessage.length > 0 ? finalMessage : []];
  }
  const initialMessageContent: (string | h)[] = [];
  const followUpMessages: (string | h)[][] = [];
  for (const el of caveHElements) {
    if (problematicTypes.includes(el.type) || (el.type === 'message' && el.attrs.forward)) {
      const placeholderKey = (el.type === 'message' && el.attrs.forward) ? 'forward' : el.type;
      initialMessageContent.push(h.text(placeholderMap[placeholderKey]));
      followUpMessages.push([el]);
    } else {
      initialMessageContent.push(el);
    }
  }
  const finalInitialMessage: (string | h)[] = [];
  if (header) finalInitialMessage.push(header + '\n');
  finalInitialMessage.push(...initialMessageContent);
  if (footer) finalInitialMessage.push('\n' + footer);
  return [finalInitialMessage, ...followUpMessages].filter(msg => msg.length > 0);
}

/**
 * @description 获取下一个可用的回声洞 ID，采用“回收ID > 扫描空缺 > 最大ID+1”策略。
 * @param ctx Koishi 上下文。
 * @param reusableIds 可复用 ID 的内存缓存。
 * @returns 可用的新 ID。
 */
export async function getNextCaveId(ctx: Context, reusableIds: Set<number>): Promise<number> {
  for (const id of reusableIds) {
    if (id > 0) {
      reusableIds.delete(id);
      return id;
    }
  }
  if (reusableIds.has(0)) {
    reusableIds.delete(0);
    const [lastCave] = await ctx.database.get('cave', {}, { sort: { id: 'desc' }, limit: 1 });
    const newId = (lastCave?.id || 0) + 1;
    reusableIds.add(0);
    return newId;
  }
  const allCaveIds = (await ctx.database.get('cave', {}, { fields: ['id'] })).map(c => c.id);
  const existingIds = new Set(allCaveIds);
  let newId = 1;
  while (existingIds.has(newId)) newId++;
  if (existingIds.size === (allCaveIds.length > 0 ? Math.max(...allCaveIds) : 0)) reusableIds.add(0);
  return newId;
}

/**
 * @description 解析消息元素，分离出文本和待下载的媒体文件。
 * @param sourceElements 原始的 Koishi 消息元素数组。
 * @param newId 这条回声洞的新 ID。
 * @param session 触发操作的会话。
 * @param config 插件配置。
 * @param logger 日志实例。
 * @param creationTime 统一的创建时间戳，用于生成文件名。
 * @returns 包含数据库元素和待保存媒体列表的对象。
 */
export async function processMessageElements(sourceElements: h[], newId: number, session: Session, creationTime: Date): Promise<{ finalElementsForDb: StoredElement[], mediaToSave: { sourceUrl: string, fileName: string }[] }> {
  const mediaToSave: { sourceUrl: string, fileName: string }[] = [];
  const urlToFileMap = new Map<string, string>();
  let mediaIndex = 0;
  const typeMap = { 'img': 'image', 'image': 'image', 'video': 'video', 'audio': 'audio', 'file': 'file', 'text': 'text', 'at': 'at', 'forward': 'forward', 'reply': 'reply', 'face': 'face' };
  const defaultExtMap = { 'image': '.jpg', 'video': '.mp4', 'audio': '.mp3', 'file': '.dat' };
  async function transform(elements: h[]): Promise<StoredElement[]> {
    const result: StoredElement[] = [];
    async function processForwardContent(segments: any[]): Promise<StoredElement[]> {
      const innerResult: StoredElement[] = [];
      for (const segment of segments) {
        const sType = typeMap[segment.type];
        if (!sType) continue;
        if (sType === 'text' && segment.data?.text?.trim()) {
          innerResult.push({ type: 'text', content: segment.data.text.trim() });
        } else if (sType === 'at' && (segment.data?.id || segment.data?.qq)) {
          innerResult.push({ type: 'at', content: (segment.data.id || segment.data.qq) as string });
        } else if (sType === 'reply' && segment.data?.id) {
          innerResult.push({ type: 'reply', content: segment.data.id as string });
        } else if (['image', 'video', 'audio', 'file'].includes(sType) && (segment.data?.src || segment.data?.url)) {
          let fileIdentifier = (segment.data.src || segment.data.url) as string;
          if (fileIdentifier.startsWith('http')) {
            if (urlToFileMap.has(fileIdentifier)) {
                fileIdentifier = urlToFileMap.get(fileIdentifier)!;
            } else {
                const ext = path.extname(segment.data.file as string || '') || defaultExtMap[sType];
                const currentMediaIndex = ++mediaIndex;
                const newFileName = `${newId}_${currentMediaIndex}_${session.channelId || session.guildId}_${session.userId}_${creationTime.getTime()}${ext}`;
                mediaToSave.push({ sourceUrl: fileIdentifier, fileName: newFileName });
                urlToFileMap.set(fileIdentifier, newFileName);
                fileIdentifier = newFileName;
            }
          }
          innerResult.push({ type: sType as any, file: fileIdentifier });
        } else if (sType === 'forward' && Array.isArray(segment.data?.content)) {
          const nestedForwardNodes: ForwardNode[] = [];
          for (const nestedNode of segment.data.content) {
            if (!nestedNode.message || !Array.isArray(nestedNode.message)) continue;
            const nestedContentElements = await processForwardContent(nestedNode.message);
            if (nestedContentElements.length > 0) {
              nestedForwardNodes.push({ userId: nestedNode.sender?.user_id, userName: nestedNode.sender?.nickname, elements: nestedContentElements });
            }
          }
          if (nestedForwardNodes.length > 0) innerResult.push({ type: 'forward', content: nestedForwardNodes });
        }
      }
      return innerResult;
    }
    for (const el of elements) {
      const type = typeMap[el.type];
      if (!type) {
        if (el.children) result.push(...await transform(el.children));
        continue;
      }
      if (type === 'text' && el.attrs.content?.trim()) {
        result.push({ type: 'text', content: el.attrs.content.trim() });
      } else if (type === 'at' && el.attrs.id) {
        result.push({ type: 'at', content: el.attrs.id as string });
      } else if (type === 'reply' && el.attrs.id) {
        result.push({ type: 'reply', content: el.attrs.id as string });
      } else if (type === 'forward' && Array.isArray(el.attrs.content)) {
        const forwardNodes: ForwardNode[] = [];
        for (const node of el.attrs.content) {
          if (!node.message || !Array.isArray(node.message)) continue;
          const contentElements = await processForwardContent(node.message);
          if (contentElements.length > 0) {
            forwardNodes.push({ userId: node.sender?.user_id, userName: node.sender?.nickname, elements: contentElements });
          }
        }
        if (forwardNodes.length > 0) result.push({ type: 'forward', content: forwardNodes });
      } else if (['image', 'video', 'audio', 'file'].includes(type) && el.attrs.src) {
        let fileIdentifier = el.attrs.src as string;
        if (fileIdentifier.startsWith('http')) {
            if (urlToFileMap.has(fileIdentifier)) {
                fileIdentifier = urlToFileMap.get(fileIdentifier)!;
            } else {
                const ext = path.extname(el.attrs.file as string || '') || defaultExtMap[type];
                const currentMediaIndex = ++mediaIndex;
                const newFileName = `${newId}-${currentMediaIndex}_${session.channelId}-${session.userId}_${creationTime.getTime()}${ext}`;
                mediaToSave.push({ sourceUrl: fileIdentifier, fileName: newFileName });
                urlToFileMap.set(fileIdentifier, newFileName);
                fileIdentifier = newFileName;
            }
        }
        result.push({ type: type as any, file: fileIdentifier });
      } else if (type === 'face' && el.attrs.id) {
        result.push({ type: 'face', content: el.attrs.id as string });
      }
    }
    return result;
  }
  const finalElementsForDb = await transform(sourceElements);
  return { finalElementsForDb, mediaToSave };
}

/**
 * @description 根据提供的配对关系，将项目 ID 进行聚类。
 * @param pairs 一个由 [number, number] 组成的数组，代表需要合并的项目 ID 配对。
 * @returns 返回一个二维数组，每个子数组代表一个大小大于1的聚类。
 */
export function clusterItemsFromPairs(pairs: [number, number][]): number[][] {
  const parent = new Map<number, number>();
  const allIds = new Set<number>();
  const find = (i: number): number => {
    if (!parent.has(i)) {
      parent.set(i, i);
      return i;
    }
    if (parent.get(i) === i) return i;
    const root = find(parent.get(i)!);
    parent.set(i, root);
    return root;
  };
  const union = (i: number, j: number): void => {
    const rootI = find(i);
    const rootJ = find(j);
    if (rootI !== rootJ) parent.set(rootI, rootJ);
  };
  for (const [id1, id2] of pairs) {
    union(id1, id2);
    allIds.add(id1);
    allIds.add(id2);
  }
  if (allIds.size === 0) return [];
  const clusterMap = new Map<number, number[]>();
  allIds.forEach(id => {
    const root = find(id);
    if (!clusterMap.has(root)) clusterMap.set(root, []);
    clusterMap.get(root)!.push(id);
  });
  return Array.from(clusterMap.values()).filter(c => c.length > 1);
}

/**
 * @description 通用的 LSH (局部敏感哈希) 候选对生成器。
 * @param items 要处理的项目数组。
 * @param getBucketInfo 一个函数，接收单个项目，并返回其唯一 ID 和一个桶键数组。
 * @returns 一个 Set，包含所有候选对的字符串键 (e.g., "123-456")。
 */
export function generateFromLSH<T>(items: T[], getBucketInfo: (item: T) => { id: number; keys: string[] }): Set<string> {
  const buckets = new Map<string, number[]>();
  items.forEach(item => {
    const { id, keys } = getBucketInfo(item);
    if (!id || !keys || keys.length === 0) return;
    keys.forEach(key => {
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(id);
    });
  });

  const candidatePairs = new Set<string>();
  for (const ids of buckets.values()) {
    if (ids.length < 2) continue;
    const uniqueIds = [...new Set(ids)].sort((a, b) => a - b);
    if (uniqueIds.length < 2) continue;
    for (let i = 0; i < uniqueIds.length; i++) {
      for (let j = i + 1; j < uniqueIds.length; j++) {
        const pairKey = `${uniqueIds[i]}-${uniqueIds[j]}`;
        candidatePairs.add(pairKey);
      }
    }
  }
  return candidatePairs;
}

/**
 * @description 处理新回声洞创建后的后续逻辑，包括媒体下载、查重、AI分析、哈希存储和状态更新。
 * @param ctx Koishi 上下文。
 * @param config 插件配置。
 * @param fileManager 文件管理器实例。
 * @param logger 日志记录器实例。
 * @param reusableIds 可复用 ID 的内存缓存。
 * @param newCave 已初步创建（status: 'preload'）的回声洞对象。
 * @param mediaToSave 待保存的媒体文件列表。
 * @param session 触发操作的会话。
 * @param hashManager 哈希管理器实例（如果启用）。
 * @param aiManager AI管理器实例（如果启用）。
 * @param reviewManager 审核管理器实例（如果启用）。
 */
export async function processNewCave(ctx: Context, config: Config, fileManager: FileManager, logger: Logger, reusableIds: Set<number>, newCave: CaveObject, session: Session,
  mediaToSave: { sourceUrl: string, fileName: string }[], hashManager: HashManager | null, aiManager: AIManager | null, reviewManager: PendManager | null,): Promise<void> {
  const newId = newCave.id;
  try {
    const initialDownloads: { candidateFile: string, buffer: Buffer }[] = [];
    if (mediaToSave.length > 0) {
        const downloadPromises = mediaToSave.map(async (media) => {
            const buffer = Buffer.from(await ctx.http.get(media.sourceUrl, { responseType: 'arraybuffer', timeout: 60000 }));
            return { candidateFile: media.fileName, buffer };
        });
        initialDownloads.push(...await Promise.all(downloadPromises));
    }
    const hashToCanonicalFile = new Map<string, string>();
    const canonicalFilesToSave = new Map<string, Buffer>();
    const fileRemapping = new Map<string, string>();
    const mediaForProcessing: { fileName: string, buffer: Buffer }[] = [];
    if (hashManager) {
        for (const download of initialDownloads) {
            if (['.png', '.jpg', '.jpeg', '.webp'].includes(path.extname(download.candidateFile).toLowerCase())) download.buffer = hashManager.sanitizeImageBuffer(download.buffer);
            const hash = await hashManager.generatePHash(download.buffer);
            if (hashToCanonicalFile.has(hash)) {
                fileRemapping.set(download.candidateFile, hashToCanonicalFile.get(hash)!);
            } else {
                hashToCanonicalFile.set(hash, download.candidateFile);
                canonicalFilesToSave.set(download.candidateFile, download.buffer);
                fileRemapping.set(download.candidateFile, download.candidateFile);
                mediaForProcessing.push({ fileName: download.candidateFile, buffer: download.buffer });
            }
        }
        newCave.elements.forEach(el => { if (el.file && fileRemapping.has(el.file)) el.file = fileRemapping.get(el.file) });
    } else {
        initialDownloads.forEach(d => canonicalFilesToSave.set(d.candidateFile, d.buffer));
        mediaForProcessing.push(...initialDownloads.map(d => ({ fileName: d.candidateFile, buffer: d.buffer })));
    }
    let textHashesToStore: Omit<CaveHashObject, 'cave'>[] = [];
    let imageHashesToStore: Omit<CaveHashObject, 'cave'>[] = [];
    if (config.enableSimilarity && hashManager) {
      try {
        const combinedText = newCave.elements.filter(el => el.type === 'text' && typeof el.content === 'string').map(el => el.content).join(' ');
        if (combinedText) {
          const newSimhash = hashManager.generateTextSimhash(combinedText);
          if (newSimhash) {
            const existingTextHashes = await ctx.database.get('cave_hash', { type: 'text' });
            for (const existing of existingTextHashes) {
              const similarity = hashManager.calculateSimilarity(newSimhash, existing.hash);
              if (similarity >= config.textThreshold) {
                await session.send(`回声洞（${newId}）添加失败：文本与回声洞（${existing.cave}）的相似度（${similarity.toFixed(2)}%）超过阈值`);
                await ctx.database.upsert('cave', [{ id: newId, status: 'delete' }]);
                return;
              }
            }
            textHashesToStore.push({ hash: newSimhash, type: 'text' });
          }
        }
        if (mediaForProcessing.length > 0) {
          const dbImageHashes = await ctx.database.get('cave_hash', { type: 'image' });
          const newImageHashes = new Set<string>();
          for (const media of mediaForProcessing) {
            if (['.png', '.jpg', '.jpeg', '.webp'].includes(path.extname(media.fileName).toLowerCase())) {
              const imageHash = await hashManager.generatePHash(media.buffer);
              if (newImageHashes.has(imageHash)) continue;
              for (const existing of dbImageHashes) {
                const similarity = hashManager.calculateSimilarity(imageHash, existing.hash);
                if (similarity >= config.imageThreshold) {
                  await session.send(`回声洞（${newId}）添加失败：图片与回声洞（${existing.cave}）的相似度（${similarity.toFixed(2)}%）超过阈值`);
                  await ctx.database.upsert('cave', [{ id: newId, status: 'delete' }]);
                  return;
                }
              }
              newImageHashes.add(imageHash);
            }
          }
          imageHashesToStore = Array.from(newImageHashes).map(hash => ({ hash, type: 'image' }));
        }
      } catch (error) {
        logger.warn('相似度比较失败:', error);
      }
    }
    if (canonicalFilesToSave.size > 0) await Promise.all(Array.from(canonicalFilesToSave.entries()).map(([fileName, buffer]) => fileManager.saveFile(fileName, buffer)));
    let analysisResult: CaveMetaObject | undefined;
    if (config.enableAI && aiManager) {
      const analyses = await aiManager.analyze([newCave], mediaForProcessing);
      if (analyses.length > 0) {
        analysisResult = analyses[0];
        await ctx.database.upsert('cave_meta', analyses);
        const duplicateIds = await aiManager.checkForDuplicates(analysisResult, newCave);
        if (duplicateIds?.length > 0) {
          await session.send(`回声洞（${newId}）添加失败：内容与回声洞（${duplicateIds.join('|')}）重复`);
          await ctx.database.upsert('cave', [{ id: newId, status: 'delete' }]);
          return;
        }
      }
    }
    if (config.enableSimilarity && hashManager) {
      const allHashesToInsert = [...textHashesToStore, ...imageHashesToStore].map(h => ({ ...h, cave: newCave.id }));
      if (allHashesToInsert.length > 0) await ctx.database.upsert('cave_hash', allHashesToInsert);
    }
    let finalStatus: CaveObject['status'] = 'active';
    const needsManualReview = config.enablePend && session.cid !== config.adminChannel;
    if (needsManualReview) {
      if (config.enableAI && config.enableApprove && analysisResult) {
        if (analysisResult.rating >= config.approveThreshold) {
          finalStatus = 'active';
        } else if (config.onAIReviewFail) {
          finalStatus = 'pending';
        } else {
          await session.send(`回声洞（${newId}）添加失败：AI 审核未通过 (评分: ${analysisResult.rating})`);
          await ctx.database.upsert('cave', [{ id: newId, status: 'delete' }]);
          return;
        }
      } else {
        finalStatus = 'pending';
      }
    }
    await ctx.database.upsert('cave', [{ id: newId, status: finalStatus, elements: newCave.elements }]);
    if (finalStatus === 'pending' && reviewManager) reviewManager.sendForPend({ ...newCave, status: finalStatus });
  } catch (error) {
    logger.error(`回声洞（${newId}）处理失败:`, error);
    await ctx.database.upsert('cave', [{ id: newId, status: 'delete' }]);
    await session.send(`回声洞（${newId}）处理失败: ${error.message}`);
  }
}
