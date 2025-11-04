import { Context, Logger } from 'koishi';
import { Config, CaveObject } from './index';
import Jimp from 'jimp';
import { FileManager } from './FileManager';
import * as crypto from 'crypto';
import { requireAdmin, DSU, generateFromLSH } from './Utils';

/**
 * @description 数据库 `cave_hash` 表的完整对象模型。
 */
export interface CaveHashObject {
  cave: number;
  hash: string;
  type: 'text' | 'image';
}

/**
 * @class HashManager
 * @description 负责生成、存储和比较文本与图片的哈希值。
 * 实现了基于 Simhash 的文本查重和基于 DCT 感知哈希 (pHash) 的图片查重方案。
 */
export class HashManager {

  /**
   * @constructor
   * @param ctx - Koishi 上下文，用于数据库操作。
   * @param config - 插件配置，用于获取相似度阈值等。
   * @param logger - 日志记录器实例。
   * @param fileManager - 文件管理器实例，用于读取图片文件。
   */
  constructor(
    private ctx: Context,
    private config: Config,
    private logger: Logger,
    private fileManager: FileManager,
  ) {
    this.ctx.model.extend('cave_hash', {
      cave: 'unsigned',
      hash: 'string',
      type: 'string',
    }, {
      primary: ['cave', 'hash', 'type'],
      indexes: ['type'],
    });
  }

  /**
   * @description 注册与哈希功能相关的子命令。
   * @param cave - 主 `cave` 命令实例。
   */
  public registerCommands(cave) {
    cave.subcommand('.hash', '校验回声洞', { hidden: true, authority: 3 })
      .usage('校验缺失哈希的回声洞，补全哈希记录。')
      .action(async ({ session }) => {
        if (requireAdmin(session, this.config)) return requireAdmin(session, this.config);
        try {
          const allCaves = await this.ctx.database.get('cave', { status: 'active' });
          const existingHashes = await this.ctx.database.get('cave_hash', {}, { fields: ['cave'] });
          const hashedCaveIds = new Set(existingHashes.map(h => h.cave));
          const cavesToProcess = allCaves.filter(cave => !hashedCaveIds.has(cave.id));
          if (cavesToProcess.length === 0) return '无需补全回声洞哈希';
          await session.send(`开始补全 ${cavesToProcess.length} 个回声洞的哈希...`);
          let hashesToInsert: CaveHashObject[] = [];
          let processedCaveCount = 0;
          let totalHashesGenerated = 0;
          let errorCount = 0;
          const flushBatch = async () => {
            if (hashesToInsert.length === 0) return;
            await this.ctx.database.upsert('cave_hash', hashesToInsert);
            totalHashesGenerated += hashesToInsert.length;
            this.logger.info(`[${processedCaveCount}/${cavesToProcess.length}] 正在导入 ${hashesToInsert.length} 条回声洞哈希...`);
            hashesToInsert = [];
          };
          for (const cave of cavesToProcess) {
            processedCaveCount++;
            try {
              const tempHashes: CaveHashObject[] = [];
              const uniqueHashTracker = new Set<string>();
              const addUniqueHash = (hashObj: CaveHashObject) => {
                  const key = `${hashObj.hash}-${hashObj.type}`;
                  if (!uniqueHashTracker.has(key)) {
                      tempHashes.push(hashObj);
                      uniqueHashTracker.add(key);
                  }
              }
              const combinedText = cave.elements.filter(el => el.type === 'text' && el.content).map(el => el.content).join(' ');
              if (combinedText) {
                const textHash = this.generateTextSimhash(combinedText);
                if (textHash) addUniqueHash({ cave: cave.id, hash: textHash, type: 'text' });
              }
              for (const el of cave.elements.filter(el => el.type === 'image' && el.file)) {
                const imageBuffer = await this.fileManager.readFile(el.file);
                const imageHash = await this.generatePHash(imageBuffer);
                addUniqueHash({ cave: cave.id, hash: imageHash, type: 'image' });
              }
              const newHashesForCave = tempHashes;
              if (newHashesForCave.length > 0) hashesToInsert.push(...newHashesForCave);
              if (hashesToInsert.length >= 100) await flushBatch();
            } catch (error) {
              errorCount++;
              this.logger.warn(`补全回声洞（${cave.id}）哈希时出错: ${error.message}`);
            }
          }
          await flushBatch();
          const successCount = processedCaveCount - errorCount;
          return `已补全 ${successCount} 个回声洞的 ${totalHashesGenerated} 条哈希（失败 ${errorCount} 条）`;
        } catch (error) {
          this.logger.error('补全哈希失败:', error);
          return `操作失败: ${error.message}`;
        }
      });

    cave.subcommand('.check', '检查相似度', { hidden: true })
      .usage('检查所有回声洞，找出相似度过高的内容。')
      .option('textThreshold', '-t <threshold:number> 文本相似度阈值 (%)')
      .option('imageThreshold', '-i <threshold:number> 图片相似度阈值 (%)')
      .action(async ({ session, options }) => {
        if (requireAdmin(session, this.config)) return requireAdmin(session, this.config);
        await session.send('正在检查，请稍候...');
        try {
          const textThreshold = options.textThreshold ?? this.config.textThreshold;
          const imageThreshold = options.imageThreshold ?? this.config.imageThreshold;
          const allHashes = await this.ctx.database.get('cave_hash', {});
          if (allHashes.length < 2) return '无可比较哈希';
          const candidatePairs = generateFromLSH(allHashes, (hashObj) => {
            const binHash = BigInt('0x' + hashObj.hash).toString(2).padStart(64, '0');
            const keys: string[] = [];
            for (let i = 0; i < 4; i++) {
              const band = binHash.substring(i * 16, (i + 1) * 16);
              keys.push(`${hashObj.type}:${i}:${band}`);
            }
            return { id: hashObj.cave, keys };
          });
          const hashLookup = new Map<number, { text?: string, image?: string }>();
          allHashes.forEach(h => {
              if (!hashLookup.has(h.cave)) hashLookup.set(h.cave, {});
              hashLookup.get(h.cave)[h.type] = h.hash;
          });
          const textPairs: { id1: number, id2: number, similarity: number }[] = [];
          const imagePairs: { id1: number, id2: number, similarity: number }[] = [];
          for (const pairKey of candidatePairs) {
            const [id1, id2] = pairKey.split('-').map(Number);
            const cave1Hashes = hashLookup.get(id1);
            const cave2Hashes = hashLookup.get(id2);
            if (cave1Hashes?.text && cave2Hashes?.text) {
              const similarity = this.calculateSimilarity(cave1Hashes.text, cave2Hashes.text);
              if (similarity >= textThreshold) textPairs.push({ id1, id2, similarity });
            }
            if (cave1Hashes?.image && cave2Hashes?.image) {
              const similarity = this.calculateSimilarity(cave1Hashes.image, cave2Hashes.image);
              if (similarity >= imageThreshold) imagePairs.push({ id1, id2, similarity });
            }
          }
          if (textPairs.length === 0 && imagePairs.length === 0) return '未发现高相似度的内容';
          const generateReportForType = (pairs: { id1: number, id2: number, similarity: number }[]): { reportLines: string[], clusters: number[][] } => {
            if (pairs.length === 0) return { reportLines: [], clusters: [] };
            const dsu = new DSU();
            const allIds = new Set<number>();
            pairs.forEach(p => { dsu.union(p.id1, p.id2); allIds.add(p.id1); allIds.add(p.id2); });
            const clusterMap = new Map<number, number[]>();
            allIds.forEach(id => {
              const root = dsu.find(id);
              if (!clusterMap.has(root)) clusterMap.set(root, []);
              clusterMap.get(root)!.push(id);
            });
            const validClusters = Array.from(clusterMap.values()).filter(c => c.length > 1);
            const reportLines: string[] = [];
            validClusters.forEach(cluster => {
              const sortedCluster = cluster.sort((a, b) => a - b);
              const clusterPairs = pairs
                  .filter(p => cluster.includes(p.id1) && cluster.includes(p.id2))
                  .sort((a, b) => b.similarity - a.similarity);
              const scores = clusterPairs.map(p => `${p.similarity.toFixed(2)}%`).join('/');
              reportLines.push(`- ${sortedCluster.join('|')} = ${scores}`);
            });
            return { reportLines, clusters: validClusters };
          };
          const textResult = generateReportForType(textPairs);
          const imageResult = generateReportForType(imagePairs);
          const totalClusters = textResult.clusters.length + imageResult.clusters.length;
          if (totalClusters === 0) return '未发现高相似度的内容';
          let report = `共发现 ${totalClusters} 组高相似度的内容:`;
          if (textResult.reportLines.length > 0) {
            report += `\n[文本相似]`;
            report += `\n${textResult.reportLines.join('\n')}`;
          }
          if (imageResult.reportLines.length > 0) {
            report += `\n[图片相似]`;
            report += `\n${imageResult.reportLines.join('\n')}`;
          }
          return report.trim();
        } catch (error) {
          this.logger.error('检查相似度失败:', error);
          return `检查失败: ${error.message}`;
        }
      });

    cave.subcommand('.fix [...ids:posint]', '修复回声洞', { hidden: true, authority: 3 })
      .usage('扫描并修复回声洞中的图片，可指定一个或多个 ID。')
      .action(async ({ session }, ...ids: number[]) => {
        if (requireAdmin(session, this.config)) return requireAdmin(session, this.config);
        let cavesToProcess: CaveObject[];
        try {
          await session.send('正在修复，请稍候...');
          if (ids.length === 0) {
            cavesToProcess = await this.ctx.database.get('cave', { status: 'active' });
          } else {
            cavesToProcess = await this.ctx.database.get('cave', { id: { $in: ids }, status: 'active' });
          }
          if (!cavesToProcess.length) return '无可修复的回声洞';
          let fixedFiles = 0;
          let errorCount = 0;
          for (const cave of cavesToProcess) {
            const imageElements = cave.elements.filter(el => el.type === 'image' && el.file);
            for (const element of imageElements) {
              try {
                const originalBuffer = await this.fileManager.readFile(element.file);
                const sanitizedBuffer = this.sanitizeImageBuffer(originalBuffer);
                if (!originalBuffer.equals(sanitizedBuffer)) {
                  await this.fileManager.saveFile(element.file, sanitizedBuffer);
                  fixedFiles++;
                }
              } catch (error) {
                if (error.code !== 'ENOENT' && error.name !== 'NoSuchKey') {
                   this.logger.warn(`无法修复回声洞（${cave.id}）的图片（${element.file}）:`, error);
                   errorCount++;
                }
              }
            }
          }
          return `已修复 ${cavesToProcess.length} 个回声洞的 ${fixedFiles} 张图片（失败 ${errorCount} 条）`;
        } catch (error) {
          this.logger.error('修复图像文件时发生严重错误:', error);
          return `操作失败: ${error.message}`;
        }
      });
  }

  /**
   * @description 扫描并修复单个图片 Buffer，移除文件结束符之后的多余数据。
   * @param imageBuffer - 原始的图片 Buffer。
   * @returns 修复后的图片 Buffer。如果无需修复，则返回原始 Buffer。
   */
  public sanitizeImageBuffer(imageBuffer: Buffer): Buffer {
    const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const JPEG_SIGNATURE = Buffer.from([0xFF, 0xD8]);
    const GIF_SIGNATURE = Buffer.from('GIF');
    let sanitizedBuffer = imageBuffer;
    if (imageBuffer.slice(0, 8).equals(PNG_SIGNATURE)) {
        const IEND_CHUNK = Buffer.from('IEND');
        const iendIndex = imageBuffer.lastIndexOf(IEND_CHUNK);
        if (iendIndex !== -1) {
            const endOfPngData = iendIndex + 8;
            if (imageBuffer.length > endOfPngData) sanitizedBuffer = imageBuffer.slice(0, endOfPngData);
        }
    } else if (imageBuffer.slice(0, 2).equals(JPEG_SIGNATURE)) {
        const EOI_MARKER = Buffer.from([0xFF, 0xD9]);
        const eoiIndex = imageBuffer.lastIndexOf(EOI_MARKER);
        if (eoiIndex !== -1) {
            const endOfJpegData = eoiIndex + 2;
            if (imageBuffer.length > endOfJpegData) sanitizedBuffer = imageBuffer.slice(0, endOfJpegData);
        }
    } else if (imageBuffer.slice(0, 3).equals(GIF_SIGNATURE)) {
        const GIF_TERMINATOR = Buffer.from([0x3B]);
        const terminatorIndex = imageBuffer.lastIndexOf(GIF_TERMINATOR);
        if (terminatorIndex !== -1) {
            const endOfGifData = terminatorIndex + 1;
            if (imageBuffer.length > endOfGifData) sanitizedBuffer = imageBuffer.slice(0, endOfGifData);
        }
    }
    return sanitizedBuffer;
  }

  /**
   * @description 执行一维离散余弦变换 (DCT-II) 的方法。
   * @param input - 输入的数字数组。
   * @returns DCT 变换后的数组。
   */
  private dct1D(input: number[]): number[] {
    const N = input.length;
    const output = new Array(N).fill(0);
    const c0 = 1 / Math.sqrt(2);
    for (let k = 0; k < N; k++) {
      let sum = 0;
      for (let n = 0; n < N; n++) sum += input[n] * Math.cos((Math.PI * (2 * n + 1) * k) / (2 * N));
      const ck = (k === 0) ? c0 : 1;
      output[k] = Math.sqrt(2 / N) * ck * sum;
    }
    return output;
  }

  /**
   * @description 执行二维离散余弦变换 (DCT-II) 的方法。
   * 通过对行和列分别应用一维 DCT 来实现。
   * @param matrix - 输入的 N x N 像素亮度矩阵。
   * @returns DCT 变换后的 N x N 系数矩阵。
   */
  private dct2D(matrix: number[][]): number[][] {
    const N = matrix.length;
    if (N === 0) return [];
    const tempMatrix = matrix.map(row => this.dct1D(row));
    const transposed = tempMatrix.map((_, colIndex) => tempMatrix.map(row => row[colIndex]));
    const dctResultTransposed = transposed.map(row => this.dct1D(row));
    const dctResult = dctResultTransposed.map((_, colIndex) => dctResultTransposed.map(row => row[colIndex]));
    return dctResult;
  }

  /**
   * @description pHash 算法核心实现，使用 Jimp 和自定义 DCT。
   * @param imageBuffer - 图片的 Buffer。
   * @returns 64位十六进制 pHash 字符串。
   */
  public async generatePHash(imageBuffer: Buffer): Promise<string> {
    const image = await Jimp.read(imageBuffer);
    image.resize(32, 32, Jimp.RESIZE_BILINEAR).greyscale();
    const matrix: number[][] = Array.from({ length: 32 }, () => new Array(32).fill(0));
    image.scan(0, 0, 32, 32, (x, y, idx) => { matrix[y][x] = image.bitmap.data[idx] });
    const dctMatrix = this.dct2D(matrix);
    const coefficients: number[] = [];
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) coefficients.push(dctMatrix[y][x]);
    const acCoefficients = coefficients.slice(1);
    const average = acCoefficients.reduce((sum, val) => sum + val, 0) / acCoefficients.length;
    let binaryHash = '';
    for (const val of coefficients) binaryHash += (val > average) ? '1' : '0';
    return BigInt('0b' + binaryHash).toString(16).padStart(16, '0');
  }

  /**
   * @description 计算两个十六进制哈希字符串之间的汉明距离 (不同位的数量)。
   * @param hex1 - 第一个哈希。
   * @param hex2 - 第二个哈希。
   * @returns 汉明距离。
   */
  public calculateHammingDistance(hex1: string, hex2: string): number {
    let distance = 0;
    let bin1 = '';
    for (const char of hex1) bin1 += parseInt(char, 16).toString(2).padStart(4, '0');
    let bin2 = '';
    for (const char of hex2) bin2 += parseInt(char, 16).toString(2).padStart(4, '0');
    const len = Math.min(bin1.length, bin2.length);
    for (let i = 0; i < len; i++) if (bin1[i] !== bin2[i]) distance++;
    return distance;
  }

  /**
   * @description 根据汉明距离计算相似度百分比。
   * @param hex1 - 第一个哈希。
   * @param hex2 - 第二个哈希。
   * @returns 相似度 (0-100)。
   */
  public calculateSimilarity(hex1: string, hex2: string): number {
    const distance = this.calculateHammingDistance(hex1, hex2);
    const hashLength = Math.max(hex1.length, hex2.length) * 4;
    return hashLength === 0 ? 100 : (1 - (distance / hashLength)) * 100;
  }

  /**
   * @description 为文本生成 64 位 Simhash 字符串。
   * @param text - 需要处理的文本。
   * @returns 16位十六进制 Simhash 字符串。
   */
  public generateTextSimhash(text: string): string {
    const cleanText = (text || '').toLowerCase().replace(/\s+/g, '');
    if (!cleanText) return '';
    const tokens = Array.from(cleanText);
    const tokenArray = Array.from(new Set(tokens));
    if (tokenArray.length === 0) return '';
    const vector = new Array(64).fill(0);
    tokenArray.forEach(token => {
      const hash = crypto.createHash('md5').update(token).digest();
      for (let i = 0; i < 64; i++) vector[i] += (hash[Math.floor(i / 8)]! >> (i % 8)) & 1 ? 1 : -1;
    });
    const binaryHash = vector.map(v => v > 0 ? '1' : '0').join('');
    return BigInt('0b' + binaryHash).toString(16).padStart(16, '0');
  }
}
