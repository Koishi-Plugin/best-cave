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
`1."rating" (整数): 对内容进行公正客观的评分，以下为评分标准:
从以下维度分别评分，每项0-10分，总分为各项之和，最高100分。
  - 原创性: 评估内容的创意和独特性。
    - 8-10分: 完全原创的梗或高质量的二次创作，展现出独特的巧思。
    - 4-7分: 对现有梗或模板进行了巧妙的改造或融合，赋予了新的趣味。
    - 0-3分: 简单套用常见模板，或是陈旧内容的再利用，甚至完全照搬。
  - 内容价值: 评估内容所蕴含的幽默、情感或信息价值。
    - 8-10分: 能引发强烈共鸣或深度思考，具有极高的娱乐性或启发性。
    - 4-7分: 幽默感强，能让人会心一笑，或是在特定圈层中具有高度相关性。
    - 0-3分: 内容平淡，笑点模糊，难以引起共鸣，甚至内容空洞、无意义。
  - 视觉呈现: 评估图像的质量和元素的协调性。
    - 8-10分: 构图、P图技术或截图时机堪称完美，视觉元素清晰且极具表现力。
    - 4-7分: 图像清晰，元素搭配得当，能有效服务于主题表达，但存在轻微瑕疵。
    - 0-3分: 图像模糊、分辨率低，或视觉元素严重影响观感，甚至完全无法辨认。
  - 文本功底: 评估内容中的文字表达能力。不包含任何文本元素时，此项计为5分。
    - 8-10分: 文字精炼、幽默且一语中的，与图片配合天衣无缝。
    - 4-7分: 文字通顺，能准确表达核心笑点或信息，但可能略显啰嗦。
    - 0-3分: 文字表达不清，存在语病，或与图片关联性不强。
  - 传播潜力: 评估内容被二次创作、分享和讨论的可能性。
    - 8-10分: “梗”感十足，极易引发模仿、分享和病毒式传播。
    - 4-7分: 具有成为热点的潜质，易于在社交圈内传播和讨论。
    - 0-3分: 内容过于小众，难以被大众理解，无法引发分享意愿。
  - 娱乐效果: 评估内容的趣味性和吸引力。
    - 8-10分: 极度搞笑或有趣，能立刻吸引用户注意力并带来愉悦感。
    - 4-7分: 具有明显的笑点或趣味性，能有效调动观看者情绪。
    - 0-3分: 趣味性较弱，难以引人发笑或产生兴趣，甚至枯燥乏味。
  - 逻辑清晰: 评估内容的叙事或表达是否连贯易懂。
    - 8-10分: 无论是笑话、故事还是玩梗，逻辑都非常清晰，核心意图一目了然。
    - 4-7分: 内容主旨明确，大部分人都能轻松理解其意图，但存在细节上的模糊。
    - 0-3分: 逻辑混乱，表达不知所云，需要费力猜测其含义，甚至完全没有逻辑。
  - 制作完善: 评估内容的完整度和精良程度。
    - 8-10分: 无论是P图还是对话截图，细节处理到位，内容完整精致。
    - 4-7分: 内容主体完整，但在细节上（如裁剪、打码）存在瑕疵。
    - 0-3分: 内容残缺不全，或制作粗糙，有明显的未完成感。
  - 内容导向: 评估内容是否积极健康。
    - 8-10分: 内容积极向上，或为中性、善意的幽默。
    - 4-7分: 内容中性，不包含明显的价值观偏向。
    - 0-3分: 包含有冒犯性的元素，甚至宣扬不良价值观。
  - 内容合规: 评估内容是否符合规范。
    - 10分: 内容符合法律法规和道德规范，适合大众阅读。
    - 0分: 包含广告、引流、令人不适、争议性等NSFW内容。
2."type" (字符串): 对内容进行准确且规范的分类，以下为分类规范:
  - Game: 与电子游戏直接相关或源自于电子游戏的内容。
  - ACG: 与动漫、漫画及广义二次元文化紧密相关的内容。
  - Internet: 源于互联网的流行文化、迷因或社群现象。
  - Reality: 取材于现实世界的日常经验和场景的内容。
  - Creative: 具有原创性、艺术性或巧妙构思的内容。
  - Other: 不适合归入以上任何一类的无关或小众内容。
3."keywords" (字符串数组): 从内容中直接提取具体且全面的关键词，以下为提取准则:
  - 必须源自可直接识别的文字与元素，仅在无可识别内容时才可使用描述性关键词说明。
  - 要求需通过多维度准确定义内容，且必须规范、简短，禁止使用组合词与分类性词汇`;

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
  onAIReviewFail: boolean;
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
    onAIReviewFail: Schema.boolean().default(true).description("拒绝时转人工"),
    approveThreshold: Schema.number().min(0).max(100).step(1).default(60).description('评分阈值'),
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

/**
 * @description 执行清理任务，删除传入的回声洞对象及其关联数据。
 * @param ctx Koishi 上下文。
 * @param fileManager 文件管理器实例。
 * @param reusableIds 可复用 ID 的内存缓存。
 * @param config 插件配置。
 * @param logger 日志记录器实例。
 * @param cavesToCleanup 需要被清理的回声洞对象数组。
 */
async function cleanupCaves(ctx: Context, fileManager: FileManager, reusableIds: Set<number>, config: Config, logger: Logger, cavesToCleanup: CaveObject[]) {
  if (cavesToCleanup.length === 0) return;
  try {
    const idsToDelete = cavesToCleanup.map(c => c.id);
    for (const cave of cavesToCleanup) await Promise.all(cave.elements.filter(el => el.file).map(el => fileManager.deleteFile(el.file)));
    reusableIds.delete(0);
    idsToDelete.forEach(id => reusableIds.add(id));
    await ctx.database.remove('cave', { id: { $in: idsToDelete } });
    if (config.enableSimilarity) await ctx.database.remove('cave_hash', { cave: { $in: idsToDelete } });
    if (config.enableAI) await ctx.database.remove('cave_meta', { cave: { $in: idsToDelete } });
  } catch (error) {
    logger.error('清理回声洞出错:', error);
  }
}

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
  const reviewManager = config.enablePend ? new PendManager(ctx, config, fileManager, logger) : null;
  const hashManager = config.enableSimilarity ? new HashManager(ctx, config, logger, fileManager) : null;
  const dataManager = config.enableIO ? new DataManager(ctx, config, fileManager, logger) : null;
  const aiManager = config.enableAI ? new AIManager(ctx, config, logger, fileManager) : null;

  const cleanupInterval = ctx.setInterval(async () => {
    const cavesToDelete = await ctx.database.get('cave', { status: 'delete' });
    await cleanupCaves(ctx, fileManager, reusableIds, config, logger, cavesToDelete);
  }, 60 * 60 * 1000);

  ctx.on('dispose', async () => {
    cleanupInterval();
    const cavesMarkedForDelete = await ctx.database.get('cave', { status: 'delete' });
    const stalePreloadCaves = await ctx.database.get('cave', { status: 'preload' });
    const allCavesToCleanup = [...cavesMarkedForDelete, ...stalePreloadCaves];
    await cleanupCaves(ctx, fileManager, reusableIds, config, logger, allCavesToCleanup);
  });

  const cave = ctx.command('cave', '回声洞')
    .option('add', '-a [content:text] 添加回声洞')
    .option('view', '-g [id:posint] 查看指定回声洞')
    .option('delete', '-r [ids:text] 删除指定回声洞')
    .option('list', '-l 查询投稿统计')
    .usage('随机抽取一条已添加的回声洞。')
    .action(async ({ session, options }) => {
      if (options.add) return session.execute(`cave.add ${options.add}`);
      if (options.view) return session.execute(`cave.view ${options.view}`);
      if (options.delete) return session.execute(`cave.del ${options.delete}`);
      if (options.list) return session.execute('cave.list');
      try {
        const query = config.perChannel && session.channelId ? { status: 'active' as const, channelId: session.channelId } : { status: 'active' as const };
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
      const userName = (config.enableName && profileManager ? await profileManager.getNickname(session.userId) : null) || session.username;
      const newCave: CaveObject = { id: newId, elements: finalElementsForDb, channelId: session.channelId, userId: session.userId, userName, status: 'preload', time: creationTime };
      await ctx.database.create('cave', newCave);
      const needsReviewImmediately = config.enablePend && session.cid !== config.adminChannel;
      session.send(needsReviewImmediately ? `提交成功，序号为（${newCave.id}）` : `添加成功，序号为（${newCave.id}）`);
      utils.processNewCave(ctx, config, fileManager, logger, reusableIds, newCave, session, mediaToSave, hashManager, aiManager, reviewManager);
    });

  cave.subcommand('.view <id:posint>', '查看指定回声洞')
    .action(async ({ session }, id) => {
      if (!id) return '请输入要查看的回声洞序号';
      try {
        const scopeQuery = config.perChannel && session.channelId ? { status: 'active' as const, channelId: session.channelId } : { status: 'active' as const };
        const [targetCave] = await ctx.database.get('cave', { ...scopeQuery, id });
        if (!targetCave) return `回声洞（${id}）不存在`;
        const messages = await utils.buildCaveMessage(targetCave, config, fileManager, logger, session.platform);
        for (const message of messages) if (message.length > 0) await session.send(h.normalize(message));
      } catch (error) {
        logger.error(`查看回声洞（${id}）失败:`, error);
        return '查看失败，请稍后再试';
      }
    });

  cave.subcommand('.del [...ids:string]', '删除指定回声洞')
    .usage('删除一个或多个指定序号的回声洞，序号之间以空格或 | 分隔。')
    .action(async ({ session }, ...args: string[]) => {
      const { ids, invalid } = utils.parseCaveIds(args);
      if (ids.length === 0 && invalid.length === 0) return '请输入要删除的回声洞序号';
      try {
        const isAdmin = session.cid === config.adminChannel;
        const targetCaves = ids.length === 0 ? [] : await ctx.database.get('cave', { id: { $in: ids }, status: 'active' });
        const cavesToDelete = isAdmin ? targetCaves : targetCaves.filter(cave => cave.userId === session.userId);
        const deletableIds = new Set(cavesToDelete.map(cave => cave.id));
        const processedIds = ids.filter(id => deletableIds.has(id));
        if (processedIds.length === 0) return `回声洞（${[...invalid, ...ids].join('|')}）不存在`;
        await ctx.database.upsert('cave', processedIds.map(id => ({ id, status: 'delete' })));
        const notes: string[] = [];
        if (processedIds.length === 1) {
          const caveMessages = await utils.buildCaveMessage(cavesToDelete.find(cave => cave.id === processedIds[0]), config, fileManager, logger, session.platform, '已删除');
          for (const message of caveMessages) if (message.length > 0) await session.send(h.normalize(message));
        } else {
          notes.push(`已删除回声洞（${processedIds.join('|')}）`);
        }
        const missedIds = [...invalid, ...ids.filter(id => !processedIds.includes(id))];
        if (missedIds.length > 0) notes.push(`回声洞（${missedIds.join('|')}）不存在`);
        if (notes.length > 0) return notes.join('\n');
      } catch (error) {
        logger.error(`标记回声洞（${args.join('|')}）失败:`, error);
        return '删除失败，请稍后再试';
      }
    });

  cave.subcommand('.list', '查询投稿统计')
    .usage('查询排行或指定用户的回声洞统计。')
    .option('user', '-u <user:user> 指定用户')
    .option('all', '-a 查看排行')
    .action(async ({ session, options }) => {
      if (options.all) {
        if (session.cid !== config.adminChannel) return '此指令仅限在管理群组中使用';
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
      const scopeQuery = config.perChannel && session.channelId ? { status: 'active' as const, channelId: session.channelId } : { status: 'active' as const };
      const query = { ...scopeQuery, userId: targetUserId };
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
