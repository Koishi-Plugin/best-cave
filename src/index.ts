import { Context, Schema, Logger, h, $ } from 'koishi'
import { FileManager } from './FileManager'
import { NameManager } from './NameManager'
import { DataManager } from './DataManager'
import { PendManager } from './PendManager'
import { HashManager, CaveHashObject } from './HashManager'
import { AIManager, CaveMetaObject } from './AIManager'
import * as utils from './Utils'

export const name = 'best-cave'
export const inject = ['database']

export const usage = `
<div style="border-radius: 10px; border: 1px solid #ddd; padding: 16px; margin-bottom: 20px; box-shadow: 0 2px 5px rgba(0,0,0,0.1);">
  <h2 style="margin-top: 0; color: #4a6ee0;">📌 插件说明</h2>
  <p>📖 <strong>使用文档</strong>：请点击左上角的 <strong>插件主页</strong> 查看插件使用文档</p>
  <p>🔍 <strong>更多插件</strong>：可访问 <a href="https://github.com/YisRime" style="color:#4a6ee0;text-decoration:none;">苡淞的 GitHub</a> 查看本人的所有插件</p>
</div>
<div style="border-radius: 10px; border: 1px solid #ddd; padding: 16px; margin-bottom: 20px; box-shadow: 0 2px 5px rgba(0,0,0,0.1);">
  <h2 style="margin-top: 0; color: #e0574a;">❤️ 支持与反馈</h2>
  <p>🌟 喜欢这个插件？请在 <a href="https://github.com/YisRime" style="color:#e0574a;text-decoration:none;">GitHub</a> 上给我一个 Star！</p>
  <p>🐛 遇到问题？请通过 <strong>Issues</strong> 提交反馈，或加入 QQ 群 <a href="https://qm.qq.com/q/PdLMx9Jowq" style="color:#e0574a;text-decoration:none;"><strong>855571375</strong></a> 进行交流</p>
</div>
`

const DEFAULT_PROMPT =
`1."rating" (整数, 0-100): 对内容进行严格且有区分度的评分，以下为评分标准:
  - 基础分: 50
  +10至+20: 高原创性、创意或艺术性。
  +10至+20: 非常搞笑、幽默或有很强的笑点。
  +10至+20: 引人深思、感人或有强烈的共鸣。
  +5至+15: 玩梗巧妙或二创质量高，能识别出具体梗/文化背景。
  -10至-20: 内容质量低下(如图片模糊、有压缩痕迹、文字错别字)。
  -10至-20: 内容意义不明或非常无聊。
  -5至-15: 简单或低创意的烂梗、过时流行语。
  -20至-30: 几乎没有信息量的内容。
2."type" (字符串): 对内容进行严格且标准的分类，以下为分类标准:
  - Game: 与电子游戏直接相关或源自于电子游戏的内容。
  - ACG: 与动漫、漫画及广义二次元文化紧密相关的内容。
  - Internet: 源于互联网的通用流行文化、迷因(Meme)或社群现象。
  - Reality: 取材于现实世界的日常经验和场景的内容。
  - Creative: 具有独特的原创性、艺术性或巧妙构思的内容。
  - Other: 不适合归入以上任何一类的无关内容或小众内容。
3."keywords" (字符串数组): 从内容中提取全面且细分的关键词，以下为提取准则：
  - 直接提取: 优先从文字内容中直接提取核心词汇，而不是进行归纳或总结。提取图片中可辨识的对象、场景或文字。
  - 简洁规范: 关键词必须简短且为规范化、普遍使用的词语。例如，使用“明日方舟”而非“粥”，使用“梗”而非“梗图”。
  - 全面细分: 提取多个不同维度的关键词，包括但不限于：人物/对象、场景/地点、事件/行为、特定梗/文化元素。
  - 避免宽泛: 确保关键词具体且相关，避免使用过于宽泛或模糊的术语，避免近似关键词，所有词应完整定义内容。`;

const logger = new Logger('best-cave');

/**
 * @description 存储在合并转发中的单个节点的数据结构。
 */
export interface ForwardNode {
  userId: string;
  userName: string;
  elements: StoredElement[];
}

/**
 * @description 存储在数据库中的单个消息元素。
 */
export interface StoredElement {
  type: 'text' | 'image' | 'video' | 'audio' | 'file' | 'at' | 'forward' | 'reply' | 'face';
  content?: string | ForwardNode[];
  file?: string;
}

/**
 * @description 数据库 \`cave\` 表的完整对象模型。
 */
export interface CaveObject {
  id: number;
  elements: StoredElement[];
  channelId: string;
  userId: string;
  userName: string;
  status: 'active' | 'delete' | 'pending' | 'preload';
  time: Date;
}

declare module 'koishi' {
  interface Tables {
    cave: CaveObject;
    cave_hash: CaveHashObject;
    cave_meta: CaveMetaObject;
  }
}

export interface Config {
  perChannel: boolean;
  adminChannel: string;
  enableName: boolean;
  enableIO: boolean;
  enablePend: boolean;
  caveFormat: string;
  enableSimilarity: boolean;
  textThreshold: number;
  imageThreshold: number;
  localPath?: string;
  enableS3: boolean;
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  bucket?: string;
  publicUrl?: string;
  enableAI: boolean;
  endpoints?: {
    url: string;
    key: string;
    model: string;
  }[];
  enableApprove: boolean;
  approveThreshold: number;
  systemPrompt: string;
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    perChannel: Schema.boolean().default(false).description("启用分群模式"),
    enableName: Schema.boolean().default(false).description("启用自定义昵称"),
    enableIO: Schema.boolean().default(false).description("启用导入导出"),
    adminChannel: Schema.string().default('onebot:').description("管理群组 ID"),
    caveFormat: Schema.string().default('回声洞 ——（{id}）|—— {name}').description('自定义文本（参见 README）'),
  }).description("基础配置"),
  Schema.object({
    enablePend: Schema.boolean().default(false).description("启用审核"),
    enableSimilarity: Schema.boolean().default(false).description("启用查重"),
    textThreshold: Schema.number().min(0).max(100).step(0.01).default(95).description('文本相似度阈值 (%)'),
    imageThreshold: Schema.number().min(0).max(100).step(0.01).default(95).description('图片相似度阈值 (%)'),
  }).description('复核配置'),
  Schema.object({
    enableAI: Schema.boolean().default(false).description("启用 AI"),
    enableApprove: Schema.boolean().default(false).description("启用自动审核"),
    approveThreshold: Schema.number().min(0).max(100).step(1).default(80).description('评分阈值'),
    endpoints: Schema.array(Schema.object({
      url: Schema.string().description('端点 (Endpoint)').role('link').required(),
      key: Schema.string().description('密钥 (API Key)').role('secret'),
      model: Schema.string().description('模型 (Model)').required(),
    })).description('端点列表').role('table'),
    systemPrompt: Schema.string().role('textarea').default(DEFAULT_PROMPT).description('系统提示词'),
  }).description('模型配置'),
  Schema.object({
    localPath: Schema.string().description('文件映射路径'),
    enableS3: Schema.boolean().default(false).description("启用 S3 存储"),
    publicUrl: Schema.string().description('公共访问 URL').role('link'),
    endpoint: Schema.string().description('端点 (Endpoint)').role('link'),
    bucket: Schema.string().description('存储桶 (Bucket)'),
    region: Schema.string().default('auto').description('区域 (Region)'),
    accessKeyId: Schema.string().description('Access Key ID').role('secret'),
    secretAccessKey: Schema.string().description('Secret Access Key').role('secret'),
  }).description("存储配置"),
]);

export function apply(ctx: Context, config: Config) {
  ctx.model.extend('cave', {
    id: 'unsigned',
    elements: 'json',
    channelId: 'string',
    userId: 'string',
    userName: 'string',
    status: 'string',
    time: 'timestamp',
  }, {
    primary: 'id',
    indexes: ['status', 'channelId', 'userId'],
  });

  const fileManager = new FileManager(ctx.baseDir, config, logger);
  const reusableIds = new Set<number>();
  const profileManager = config.enableName ? new NameManager(ctx) : null;
  const reviewManager = config.enablePend ? new PendManager(ctx, config, fileManager, logger, reusableIds) : null;
  const hashManager = config.enableSimilarity ? new HashManager(ctx, config, logger, fileManager) : null;
  const dataManager = config.enableIO ? new DataManager(ctx, config, fileManager, logger) : null;
  const aiManager = config.enableAI ? new AIManager(ctx, config, logger, fileManager) : null;

  ctx.on('ready', async () => {
    try {
      const staleCaves = await ctx.database.get('cave', { status: 'preload' });
      if (staleCaves.length > 0) {
        const idsToMark = staleCaves.map(c => ({ id: c.id, status: 'delete' as const }));
        await ctx.database.upsert('cave', idsToMark);
        await utils.cleanupPendingDeletions(ctx, config, fileManager, logger, reusableIds);
      }
    } catch (error) {
      logger.error('清理残留回声洞时发生错误:', error);
    }
  });

  const cave = ctx.command('cave', '回声洞')
    .option('add', '-a <content:text> 添加回声洞')
    .option('view', '-g <id:posint> 查看指定回声洞')
    .option('delete', '-r <id:posint> 删除指定回声洞')
    .option('list', '-l 查询投稿统计')
    .usage('随机抽取一条已添加的回声洞。')
    .action(async ({ session, options }) => {
      if (options.add) return session.execute(`cave.add ${options.add}`);
      if (options.view) return session.execute(`cave.view ${options.view}`);
      if (options.delete) return session.execute(`cave.del ${options.delete}`);
      if (options.list) return session.execute('cave.list');
      try {
        const query = utils.getScopeQuery(session, config);
        const candidates = await ctx.database.get('cave', query, { fields: ['id'] });
        if (!candidates.length) return `当前${config.perChannel && session.channelId ? '本群' : ''}还没有任何回声洞`;
        const randomId = candidates[Math.floor(Math.random() * candidates.length)].id;
        const [randomCave] = await ctx.database.get('cave', { ...query, id: randomId });
        const messages = await utils.buildCaveMessage(randomCave, config, fileManager, logger, session.platform);
        for (const message of messages) if (message.length > 0) await session.send(h.normalize(message));
      } catch (error) {
        logger.error('随机获取回声洞失败:', error);
        return '随机获取回声洞失败';
      }
    });

  cave.subcommand('.add [content:text]', '添加回声洞')
    .usage('添加一条回声洞。可直接发送内容，也可回复或引用消息。')
    .action(async ({ session }, content) => {
      let sourceElements;
      if (session.quote?.elements) {
        sourceElements = session.quote.elements;
      } else if (content?.trim()) {
        sourceElements = h.parse(content);
      } else {
        await session.send("请在一分钟内发送你要添加的内容");
        const reply = await session.prompt(60000);
        if (!reply) return "等待操作超时";
        sourceElements = h.parse(reply);
      }
      // logger.info(`消息内容: \n${JSON.stringify(sourceElements, null, 2)}`); // 请勿删除此行
      // logger.info(`完整会话: \n${JSON.stringify(session, null, 2)}`); // 请勿删除此行
      const newId = await utils.getNextCaveId(ctx, reusableIds);
      const creationTime = new Date();
      const { finalElementsForDb, mediaToSave } = await utils.processMessageElements(sourceElements, newId, session, creationTime);
      // logger.info(`数据库元素: \n${JSON.stringify(finalElementsForDb, null, 2)}`); // 请勿删除此行
      if (finalElementsForDb.length === 0) return "无可添加内容";
      const userName = (config.enableName ? await profileManager.getNickname(session.userId) : null) || session.username;
      const needsReview = config.enablePend && session.cid !== config.adminChannel;
      const finalStatus: CaveObject['status'] = needsReview ? 'pending' : 'active';
      const newCave = await ctx.database.create('cave', {
        id: newId,
        elements: finalElementsForDb,
        channelId: session.channelId,
        userId: session.userId,
        userName,
        status: finalStatus,
        time: creationTime,
      });
      session.send(needsReview ? `提交成功，序号为（${newCave.id}）` : `添加成功，序号为（${newCave.id}）`);
      (async () => {
        try {
          const hasMedia = mediaToSave.length > 0;
          const downloadedMedia: { fileName: string, buffer: Buffer }[] = [];
          if (hasMedia) {
            for (const media of mediaToSave) {
              const buffer = Buffer.from(await ctx.http.get(media.sourceUrl, { responseType: 'arraybuffer', timeout: 30000 }));
              downloadedMedia.push({ fileName: media.fileName, buffer });
            }
          }
          let textHashesToStore: Omit<CaveHashObject, 'cave'>[] = [];
          let imageHashesToStore: Omit<CaveHashObject, 'cave'>[] = [];
          if (hashManager) {
            for (const media of downloadedMedia) media.buffer = hashManager.sanitizeImageBuffer(media.buffer);
            const checkResult = await utils.performSimilarityChecks(ctx, config, hashManager, logger, finalElementsForDb, downloadedMedia);
            if (checkResult.duplicate) {
              await session.send(`回声洞（${newId}）添加失败：${checkResult.message}`);
              await ctx.database.upsert('cave', [{ id: newId, status: 'delete' }]);
              await utils.cleanupPendingDeletions(ctx, config, fileManager, logger, reusableIds);
              return;
            }
            textHashesToStore = checkResult.textHashesToStore;
            imageHashesToStore = checkResult.imageHashesToStore;
          }
          if (aiManager) {
            const duplicateIds = await aiManager.checkForDuplicates(finalElementsForDb, downloadedMedia);
            if (duplicateIds?.length > 0) {
              await session.send(`回声洞（${newId}）添加失败：内容与回声洞（${duplicateIds.join('|')}）重复`);
              await ctx.database.upsert('cave', [{ id: newId, status: 'delete' }]);
              await utils.cleanupPendingDeletions(ctx, config, fileManager, logger, reusableIds);
              return;
            }
          }
          if (hasMedia) await Promise.all(downloadedMedia.map(item => fileManager.saveFile(item.fileName, item.buffer)));
          let analysisResult: CaveMetaObject | undefined;
          if (aiManager) {
            const analyses = await aiManager.analyze([newCave], downloadedMedia);
            if (analyses.length > 0) {
              analysisResult = analyses[0];
              await ctx.database.upsert('cave_meta', analyses);
            }
          }
          if (hashManager) {
            const allHashesToInsert = [...textHashesToStore, ...imageHashesToStore].map(h => ({ ...h, cave: newCave.id }));
            if (allHashesToInsert.length > 0) await ctx.database.upsert('cave_hash', allHashesToInsert);
          }
          if (finalStatus === 'pending' && reviewManager) {
            if (analysisResult && config.enableApprove && analysisResult.rating >= config.approveThreshold) {
              await ctx.database.upsert('cave', [{ id: newCave.id, status: 'active' }]);
            } else reviewManager.sendForPend(newCave);
          }
        } catch (error) {
          logger.error(`回声洞（${newId}）处理失败:`, error);
          await ctx.database.upsert('cave', [{ id: newId, status: 'delete' }]);
          await utils.cleanupPendingDeletions(ctx, config, fileManager, logger, reusableIds);
          await session.send(`回声洞（${newId}）处理失败: ${error.message}`);
        }
      })();
    });

  cave.subcommand('.view <id:posint>', '查看指定回声洞')
    .action(async ({ session }, id) => {
      if (!id) return '请输入要查看的回声洞序号';
      try {
        const [targetCave] = await ctx.database.get('cave', { ...utils.getScopeQuery(session, config), id });
        if (!targetCave) return `回声洞（${id}）不存在`;
        const messages = await utils.buildCaveMessage(targetCave, config, fileManager, logger, session.platform);
        for (const message of messages) if (message.length > 0) await session.send(h.normalize(message));
      } catch (error) {
        logger.error(`查看回声洞（${id}）失败:`, error);
        return '查看失败，请稍后再试';
      }
    });

  cave.subcommand('.del <id:posint>', '删除指定回声洞')
    .action(async ({ session }, id) => {
      if (!id) return '请输入要删除的回声洞序号';
      try {
        const [targetCave] = await ctx.database.get('cave', { id, status: 'active' });
        if (!targetCave) return `回声洞（${id}）不存在`;
        const isAuthor = targetCave.userId === session.userId;
        const isAdmin = session.cid === config.adminChannel;
        if (!isAuthor && !isAdmin) return '你没有权限删除这条回声洞';
        await ctx.database.upsert('cave', [{ id, status: 'delete' }]);
        const caveMessages = await utils.buildCaveMessage(targetCave, config, fileManager, logger, session.platform, '已删除');
        for (const message of caveMessages) if (message.length > 0) await session.send(h.normalize(message));
        utils.cleanupPendingDeletions(ctx, config, fileManager, logger, reusableIds);
      } catch (error) {
        logger.error(`标记回声洞（${id}）失败:`, error);
        return '删除失败，请稍后再试';
      }
    });

  cave.subcommand('.list', '查询投稿统计')
    .option('user', '-u <user:user> 指定用户')
    .option('all', '-a 查看排行')
    .action(async ({ session, options }) => {
      if (options.all) {
        const adminError = utils.requireAdmin(session, config);
        if (adminError) return adminError;
        try {
          const aggregatedStats = await ctx.database.select('cave', { status: 'active' })
            .groupBy(['userId', 'userName'], { count: row => $.count(row.id) }).execute();
          if (!aggregatedStats.length) return '目前没有回声洞投稿';
          const userStats = new Map<string, { userName: string, count: number }>();
          for (const stat of aggregatedStats) {
            const existing = userStats.get(stat.userId);
            if (existing) {
              existing.count += stat.count;
              const existingGroup = aggregatedStats.find(s => s.userId === stat.userId && s.userName === existing.userName);
              if (stat.count > (existingGroup?.count || 0)) existing.userName = stat.userName;
            } else {
              userStats.set(stat.userId, { userName: stat.userName, count: stat.count });
            }
          }
          const sortedStats = Array.from(userStats.values()).sort((a, b) => b.count - a.count);
          let report = '回声洞投稿数量排行：\n';
          sortedStats.forEach((stat, index) => { report += `${index + 1}. ${stat.userName}: ${stat.count} 条\n` });
          return report.trim();
        } catch (error) {
          logger.error('查询排行失败:', error);
          return '查询失败，请稍后再试';
        }
      }
      const targetUserId = options.user || session.userId;
      const isQueryingSelf = !options.user;
      const query = { ...utils.getScopeQuery(session, config), userId: targetUserId };
      const userCaves = await ctx.database.get('cave', query);
      if (!userCaves.length) return isQueryingSelf ? '你还没有投稿过回声洞' : `用户 ${targetUserId} 还没有投稿过回声洞`;
      const caveIds = userCaves.map(c => c.id).sort((a, b) => a - b).join('|');
      const userName = userCaves.sort((a,b) => b.time.getTime() - a.time.getTime())[0].userName;
      return `${isQueryingSelf ? '你' : userName}已投稿 ${userCaves.length} 条回声洞，序号为：\n${caveIds}`;
    });

  if (profileManager) profileManager.registerCommands(cave);
  if (dataManager) dataManager.registerCommands(cave);
  if (reviewManager) reviewManager.registerCommands(cave);
  if (hashManager) hashManager.registerCommands(cave);
  if (aiManager) aiManager.registerCommands(cave);
}
