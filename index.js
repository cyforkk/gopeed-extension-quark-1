/**
 * Gopeed 夸克网盘解析扩展
 * @version 1.0.3
 * @author muyan556
 */

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch";
const API_BASE_URL = "https://pan.quark.cn";
const DRIVE_BASE_URL = "https://drive-pc.quark.cn";
const MAX_RETRY = 3;
const RETRY_DELAY = 1500;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function parseShareUrl(url) {
    if (!url || typeof url !== 'string') throw new Error('无效的分享链接');
    const clean = url.replace(/\[.*?\]/g, '').trim();
    let pwdId = '', passcode = '', pdirFid = '';

    const idMatch = clean.match(/\/s\/([a-zA-Z0-9]+)/);
    if (idMatch && idMatch[1]) pwdId = idMatch[1];
    else if (clean.length > 10 && clean.match(/^[a-zA-Z0-9]+$/)) pwdId = clean;

    const pwMatch = clean.match(/[?&](pwd|password|pw)=([a-zA-Z0-9]{4})/i);
    if (pwMatch && pwMatch[2]) passcode = pwMatch[2];

    const dirMatch = clean.match(/#\/list\/share\/([a-zA-Z0-9]+)/);
    if (dirMatch && dirMatch[1]) pdirFid = dirMatch[1];

    if (!pwdId) throw new Error('无法从链接中解析出分享 ID');
    return { pwdId, passcode, pdirFid };
}

async function requestApi(url, method, data = {}, retryCount = 0) {
    const cookie = gopeed.settings.cookie;
    if (!cookie) throw new Error('未配置 Cookie，请在扩展设置中填入');

    const options = {
        method,
        headers: {
            'Cookie': cookie,
            'User-Agent': USER_AGENT,
            'Referer': `${API_BASE_URL}/`,
            'Origin': API_BASE_URL,
            'Content-Type': 'application/json;charset=UTF-8'
        }
    };
    if (method === 'POST') options.body = JSON.stringify(data);

    try {
        const response = await fetch(url, options);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const result = await response.json();

        if (result.code === 40001 || result.code === 10000) {
            throw new Error(`Cookie 已失效或登录过期，请重新获取 (代码: ${result.code})`);
        }
        return result;
    } catch (error) {
        if (error.message.includes('Cookie 已失效')) throw error;
        if (retryCount < MAX_RETRY) {
            await sleep(RETRY_DELAY);
            return requestApi(url, method, data, retryCount + 1);
        }
        throw new Error(`网络请求失败: ${error.message}`);
    }
}

// 夸克 API 接口

async function apiGetToken(pwdId, passcode) {
    const url = `${API_BASE_URL}/1/clouddrive/share/sharepage/token?pr=ucpro&fr=pc&__dt=${Date.now()}`;
    const res = await requestApi(url, 'POST', { pwd_id: pwdId, passcode: passcode || '' });

    if (res.code !== 0) {
        if (res.code === 31001) throw new Error('此分享需要提取码，请在链接末尾加上 ?pwd=密码');
        if (res.code === 31002) throw new Error('分享链接已失效或被取消');
        throw new Error(`获取 Token 失败: ${res.message} (${res.code})`);
    }
    return res.data;
}

async function apiGetDetail(pwdId, stoken, pdirFid = '') {
    const url = `${API_BASE_URL}/1/clouddrive/share/sharepage/detail?pr=ucpro&fr=pc&pwd_id=${pwdId}&stoken=${encodeURIComponent(stoken)}&pdir_fid=${pdirFid}&_page=1&_size=1000&_sort=file_type:asc,updated_at:desc&__dt=${Date.now()}`;
    const res = await requestApi(url, 'GET');
    if (res.code !== 0) throw new Error(`获取文件列表失败: ${res.message}`);
    return res.data;
}

async function apiSaveFile(pwdId, stoken, fidList, fidTokenList) {
    const url = `${DRIVE_BASE_URL}/1/clouddrive/share/sharepage/save?pr=ucpro&fr=pc`;
    const res = await requestApi(url, 'POST', {
        fid_list: fidList, fid_token_list: fidTokenList,
        to_pdir_fid: "0", pwd_id: pwdId, stoken, pdir_fid: "0", scene: "link"
    });
    if (res.code !== 0) throw new Error(`转存失败 (代码:${res.code}): ${res.message}`);
    return res.data?.task_id;
}

async function apiPollTask(taskId, fileCount = 1) {
    const maxPollTimes = Math.min(300, 30 + fileCount);
    let pollCount = 0;

    gopeed.logger.info(`[任务 ${taskId}] 云端转存排队中...`);

    while (pollCount < maxPollTimes) {
        await sleep(1000);
        pollCount++;

        if (pollCount % 10 === 0) {
            gopeed.logger.info(`[任务 ${taskId}] 处理中... 已等待 ${pollCount} 秒`);
        }

        const url = `${DRIVE_BASE_URL}/1/clouddrive/task?pr=ucpro&fr=pc&task_id=${taskId}&__dt=${Date.now()}`;
        const res = await requestApi(url, 'GET');

        if (res.data?.status === 2) {
            return res.data.save_as?.save_as_top_fids || [];
        }

        if (res.data?.status === 3) {
            throw new Error(`转存失败，云端空间满或风控触发`);
        }
    }
    throw new Error(`转存超时`);
}

async function apiGetDownloadLink(fids) {
    const url = 'https://drive.quark.cn/1/clouddrive/file/download?pr=ucpro&fr=pc';
    const res = await requestApi(url, 'POST', { fids });
    if (res.code === 23018) throw new Error('触发夸克限制(23018)，账号可能被风控');
    if (res.code !== 0) throw new Error(`获取直链失败: ${res.message}`);
    return res.data || [];
}

async function apiDeleteFile(fids) {
    const url = 'https://drive.quark.cn/1/clouddrive/file/delete?pr=ucpro&fr=pc';
    try {
        await requestApi(url, 'POST', { action_type: 2, filelist: fids, exclude_fids: [] });
    } catch (e) {
        gopeed.logger.warn(`清理失败 (忽略): ${e.message}`);
    }
}

async function apiGetCapacity() {
    const url = 'https://drive.quark.cn/1/clouddrive/member?pr=ucpro&fr=pc&fetch_subscribe=true&fetch_identity=true';
    try {
        const res = await requestApi(url, 'GET');
        if (res && res.data && res.data.total_capacity !== undefined && res.data.use_capacity !== undefined) {
            return Math.max(0, res.data.total_capacity - res.data.use_capacity);
        }
        return -1;
    } catch (e) {
        return -1;
    }
}

// 业务逻辑

async function getAllFiles(pwdId, stoken, pdirFid = '', parentPath = '') {
    const detail = await apiGetDetail(pwdId, stoken, pdirFid);
    let allFiles = [];

    for (const item of (detail.list || [])) {
        const currentPath = parentPath ? `${parentPath}/${item.file_name}` : item.file_name;
        if (item.dir) {
            const subFiles = await getAllFiles(pwdId, stoken, item.fid, currentPath);
            allFiles = allFiles.concat(subFiles);
        } else {
            allFiles.push({ ...item, path: parentPath });
        }
    }
    return allFiles;
}


async function processSmartChunks(pwdId, stoken, allFiles, availableSpace, shouldDelete) {
    const finalParsedFiles = [];
    let chunks = [];
    let skippedCount = 0;

    // 按文件大小升序排序，确保小文件优先提取
    allFiles.sort((a, b) => (a.size || 0) - (b.size || 0));

    // 预留 100MB 缓冲空间
    const safeBuffer = 100 * 1024 * 1024;
    const maxChunkSize = availableSpace !== -1 ? Math.max(0, availableSpace - safeBuffer) : Infinity;

    // 1. 基础过滤：剔除单个文件超过可用空间的超大文件
    let validFiles = [];
    for (const file of allFiles) {
        if (availableSpace !== -1 && file.size > maxChunkSize) {
            skippedCount++;
        } else {
            validFiles.push(file);
        }
    }

    if (validFiles.length === 0) {
        throw new Error(`网盘空间严重不足 (可用: ${(availableSpace / 1073741824).toFixed(2)}GB)，最小的一个文件也无法转存！`);
    }

    // 2. 动态分块与总量控制
    let currentChunk = [];
    let currentChunkSize = 0;
    let totalAccumulatedSize = 0;

    for (const file of validFiles) {
        // 【核心变更】如果不启用边存边删，且累加总容量即将超过剩余空间，则停止收录后续文件
        if (!shouldDelete && availableSpace !== -1 && (totalAccumulatedSize + file.size > maxChunkSize)) {
            skippedCount++;
            continue;
        }

        // 无论删不删，单批次 (Chunk) 的大小绝不能超过当前可用空间
        if (currentChunkSize + file.size > maxChunkSize && currentChunk.length > 0) {
            chunks.push(currentChunk);
            currentChunk = [];
            currentChunkSize = 0;
        }

        currentChunk.push(file);
        currentChunkSize += file.size;
        totalAccumulatedSize += file.size;
    }
    if (currentChunk.length > 0) chunks.push(currentChunk);

    gopeed.logger.info(`[策略] 共提交 ${allFiles.length - skippedCount} 个文件，切割为 ${chunks.length} 批次轮转。边存边删模式: ${shouldDelete ? '已开启 (解锁无限总量提取)' : '未开启 (受限于网盘总容量)'}`);

    // 3. 循环执行：存一批 -> 拿链接 -> 删一批(可选) -> 腾出空间
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        gopeed.logger.info(`[进度] 正在处理第 ${i + 1}/${chunks.length} 批次 (包含 ${chunk.length} 个文件)...`);

        const fids = chunk.map(f => f.fid);
        const tokens = chunk.map(f => f.share_fid_token || f.fid_token);

        try {
            const taskId = await apiSaveFile(pwdId, stoken, fids, tokens);
            const savedFids = await apiPollTask(taskId, chunk.length);

            if (savedFids.length > 0) {
                const downloadData = await apiGetDownloadLink(savedFids);

                const usedMap = new Set();
                downloadData.forEach(dLink => {
                    let matchIdx = chunk.findIndex((orig, idx) =>
                        !usedMap.has(idx) && orig.size === dLink.size &&
                        (dLink.file_name.includes(orig.file_name.replace(/\.[^/.]+$/, "")) || orig.file_name === dLink.file_name)
                    );
                    if (matchIdx === -1) matchIdx = chunk.findIndex((o, idx) => !usedMap.has(idx) && o.size === dLink.size);
                    if (matchIdx === -1) matchIdx = chunk.findIndex((o, idx) => !usedMap.has(idx));

                    if (matchIdx !== -1) {
                        usedMap.add(matchIdx);
                        const orig = chunk[matchIdx];
                        finalParsedFiles.push({
                            name: orig.file_name,
                            size: dLink.size,
                            path: orig.path || '',
                            url: dLink.download_url
                        });
                    }
                });

                // 核心：在处理完这一批的直链后，立即删除，腾出空间给下一批使用
                if (shouldDelete) {
                    gopeed.logger.info(`[清理] 正在释放第 ${i + 1} 批次占据的网盘空间...`);
                    await apiDeleteFile(savedFids);
                }
            }
        } catch (e) {
            gopeed.logger.error(`[警告] 第 ${i + 1} 批转存失败跳过: ${e.message}`);
        }
    }

    return { finalParsedFiles, skippedCount };
}

gopeed.events.onResolve(async (ctx) => {
    try {
        gopeed.logger.info("=== 夸克网盘解析开始 ===");

        const { pwdId, passcode, pdirFid } = parseShareUrl(ctx.req.url);

        gopeed.logger.info("1. 正在获取分享信息...");
        const tokenData = await apiGetToken(pwdId, passcode);
        const shareTitle = tokenData.title || 'Quark_Download';

        gopeed.logger.info("2. 正在递归扫描文件夹结构...");
        const allFiles = await getAllFiles(pwdId, tokenData.stoken, pdirFid);
        if (allFiles.length === 0) throw new Error('此分享链接中没有找到文件');

        const totalSize = allFiles.reduce((s, f) => s + (f.size || 0), 0);
        gopeed.logger.info(`--> 扫描完毕: 共 ${allFiles.length} 个文件，总计 ${(totalSize / 1073741824).toFixed(2)} GB`);

        gopeed.logger.info("3. 检查网盘空间，制定转存策略...");
        const availableSpace = await apiGetCapacity();
        if (availableSpace >= 0) {
            gopeed.logger.info(`--> 当前网盘单次可用承载空间: ${(availableSpace / 1073741824).toFixed(2)} GB`);
        } else {
            gopeed.logger.info(`--> 获取容量失败，将执行盲转策略`);
        }

        const shouldDelete = gopeed.settings.delete_file === "1";

        gopeed.logger.info("4. 开始轮转提取下载直链...");

        const { finalParsedFiles, skippedCount } = await processSmartChunks(pwdId, tokenData.stoken, allFiles, availableSpace, shouldDelete);

        if (finalParsedFiles.length === 0) throw new Error('提取失败，转存任务未生成有效直链');
        gopeed.logger.info(`=== 解析成功! 本次有效获取: ${finalParsedFiles.length}/${allFiles.length} 个文件直链 ===`);

        let finalTitle = shareTitle;
        if (skippedCount > 0) {
            finalTitle += ` (因空间满已跳过${skippedCount}个大文件)`;
            gopeed.logger.warn(`🔔 存在 ${skippedCount} 个文件因【自身大小】就超过了您的网盘可用空间，无法处理。`);
        }

        ctx.res = {
            name: finalTitle,
            files: finalParsedFiles.map(item => ({
                name: item.name,
                size: item.size,
                path: item.path,
                req: {
                    url: item.url,
                    extra: {
                        header: {
                            'User-Agent': USER_AGENT,
                            'Cookie': gopeed.settings.cookie
                        }
                    }
                }
            }))
        };

    } catch (error) {
        gopeed.logger.error(`致命错误: ${error.message}`);
        throw new MessageError(error.message);
    }
});