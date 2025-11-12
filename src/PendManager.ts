import { Context, h, Logger } from 'koishi';
import { CaveObject, Config } from './index';
import { FileManager } from './FileManager';
import { buildCaveMessage } from './Utils';

/**
 * @class PendManager
 * @description 负责处理回声洞的审核流程，处理新洞的提交、审核通知和审核操作。
 */
export class PendManager {
  /**
   * @param ctx Koishi 上下文。
   * @param config 插件配置。
   * @param fileManager 文件管理器实例。
   * @param logger 日志记录器实例。
   * @param reusableIds 可复用 ID 的内存缓存。
   */
  constructor(
    private ctx: Context,
    private config: Config,
    private fileManager: FileManager,
    private logger: Logger,
  ) {}

  /**
   * @description 注册与审核相关的子命令。
   * @param cave - 主 `cave` 命令实例。
   */
  public registerCommands(cave) {
    const pend = cave.subcommand('.pend [id:posint]', '审核回声洞', { hidden: true })
      .usage('查询待审核的回声洞列表，或指定 ID 查看对应待审核的回声洞。')
      .action(async ({ session }, id) => {
        if (session.cid !== this.config.adminChannel) return '此指令仅限在管理群组中使用';
        if (id) {
          const [targetCave] = await this.ctx.database.get('cave', { id });
          if (!targetCave) return `回声洞（${id}）不存在`;
          if (targetCave.status !== 'pending') return `回声洞（${id}）无需审核`;
          const caveMessages = await buildCaveMessage(targetCave, this.config, this.fileManager, this.logger, session.platform, '待审核');
          for (const message of caveMessages) if (message.length > 0) await session.send(h.normalize(message));
          return;
        }
        const pendingCaves = await this.ctx.database.get('cave', { status: 'pending' }, { fields: ['id'] });
        if (!pendingCaves.length) return '当前没有需要审核的回声洞';
        return `当前共有 ${pendingCaves.length} 条待审核回声洞，序号为：\n${pendingCaves.map(c => c.id).join('|')}`;
      });
    const createPendAction = (actionType: 'approve' | 'reject') => async ({ session }, ...ids: number[]) => {
      if (session.cid !== this.config.adminChannel) return '此指令仅限在管理群组中使用';
      let idsToProcess = ids;
      if (idsToProcess.length === 0) {
        const pendingCaves = await this.ctx.database.get('cave', { status: 'pending' }, { fields: ['id'] });
        if (!pendingCaves.length) return '当前没有需要审核的回声洞';
        idsToProcess = pendingCaves.map(c => c.id);
      }
      try {
        const targetStatus = actionType === 'approve' ? 'active' : 'delete';
        const actionText = actionType === 'approve' ? '通过' : '拒绝';
        const cavesToProcess = await this.ctx.database.get('cave', { id: { $in: idsToProcess }, status: 'pending' });
        if (cavesToProcess.length === 0) return `回声洞（${idsToProcess.join('|')}）无需审核或不存在`;
        const processedIds = cavesToProcess.map(cave => cave.id);
        await this.ctx.database.upsert('cave', processedIds.map(id => ({ id, status: targetStatus })));
        return `已${actionText}回声洞（${processedIds.join('|')}）`;
      } catch (error) {
        this.logger.error(`审核操作失败:`, error);
        return `操作失败: ${error.message}`;
      }
    };
    pend.subcommand('.Y [...ids:posint]', '通过审核')
      .usage('通过一个或多个指定 ID 的回声洞审核。若不指定 ID，则通过所有待审核的回声洞。')
      .action(createPendAction('approve'));
    pend.subcommand('.N [...ids:posint]', '拒绝审核')
      .usage('拒绝一个或多个指定 ID 的回声洞审核。若不指定 ID，则拒绝所有待审核的回声洞。')
      .action(createPendAction('reject'));
    if (this.config.enableAI) {
      pend.subcommand('.A <threshold:number>', '自动通过审核')
        .usage('根据评分自动通过不小于指定阈值的回声洞。默认使用配置中的阈值。')
        .action(async ({ session }, threshold) => {
          if (session.cid !== this.config.adminChannel) return '此指令仅限在管理群组中使用';
          const finalThreshold = threshold ?? this.config.approveThreshold;
          try {
            const pendingCaves = await this.ctx.database.get('cave', { status: 'pending' });
            if (pendingCaves.length === 0) return '当前没有需要审核的回声洞';
            const pendingCaveIds = pendingCaves.map(c => c.id);
            const pendingMeta = await this.ctx.database.get('cave_meta', { cave: { $in: pendingCaveIds } });
            const idsToApprove = pendingMeta.filter(meta => meta.rating >= finalThreshold).map(meta => meta.cave);
            if (idsToApprove.length === 0) return `没有找到评分不小于 ${finalThreshold} 的待审核回声洞`;
            await this.ctx.database.upsert('cave', idsToApprove.map(id => ({ id, status: 'active' })));
            return `已自动通过回声洞（${idsToApprove.join('|')}）`;
          } catch (error) {
            this.logger.error('自动审核操作失败:', error);
            return `操作失败: ${error.message}`;
          }
        });
    }
  }

  /**
   * @description 将新回声洞提交到管理群组以供审核。
   * @param cave 新创建的、状态为 'pending' 的回声洞对象。
   */
  public async sendForPend(cave: CaveObject): Promise<void> {
    if (!this.config.adminChannel?.includes(':')) {
      this.logger.warn(`管理群组配置无效，已自动通过回声洞（${cave.id}）`);
      await this.ctx.database.upsert('cave', [{ id: cave.id, status: 'active' }]);
      return;
    }
    try {
      const [platform] = this.config.adminChannel.split(':', 1);
      const caveMessages = await buildCaveMessage(cave, this.config, this.fileManager, this.logger, platform, '待审核');
      for (const message of caveMessages) if (message.length > 0) await this.ctx.broadcast([this.config.adminChannel], h.normalize(message));
    } catch (error) {
      this.logger.error(`发送回声洞（${cave.id}）审核消息失败:`, error);
    }
  }
}
