export default {
  async fetch(request, env, ctx) {
    // 全局兜底：任何异常都返回可读信息，避免 1101
    try {
      return await handleRequest(request, env, ctx);
    } catch (e) {
      return new Response(
        `Worker Error: ${e.message}\n\nStack:\n${e.stack || 'none'}`, 
        { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
      );
    }
  },
  async scheduled(event, env, ctx) {
    // 定时触发器：每整半小时自动执行 fetch 聚合
    try {
      await runFetchProcess(env);
    } catch (e) {
      console.error('Scheduled fetch error:', e);
    }
  }
};

async function handleRequest(request, env, ctx) {
  // 检查 KV 绑定
  if (!env || !env.LINKS_KV) {
    return new Response(
      'Error: KV binding "LINKS_KV" not found.\n\n请在 Cloudflare Dashboard > Worker Settings > KV Namespace Bindings 中绑定，或检查 wrangler.toml 配置。', 
      { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
    );
  }

  const url = new URL(request.url);
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (url.pathname === '/save' && request.method === 'POST') {
    return handleSave(request, env, corsHeaders);
  }

  if (url.pathname === '/fetch') {
    return handleFetchResult(env, corsHeaders);
  }

  if (url.pathname === '/status') {
    return handleStatus(env, corsHeaders);
  }

  if (url.pathname === '/' || url.pathname === '') {
    const accept = request.headers.get('Accept') || '';
    const userAgent = request.headers.get('User-Agent') || '';
    const isBrowser = accept.includes('text/html') || 
      /Mozilla|Chrome|Safari|Firefox|Edge/.test(userAgent);
    
    if (isBrowser) {
      return handleAdmin(env);
    } else {
      return handleFetchResult(env, corsHeaders);
    }
  }

  return handleAdmin(env);
}

async function handleSave(request, env, corsHeaders) {
  try {
    let links;
    const contentType = request.headers.get('content-type') || '';
    
    if (contentType.includes('application/x-www-form-urlencoded') || 
        contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      links = formData.get('links') || '';
    } else {
      links = await request.text();
    }
    
    await env.LINKS_KV.put('links', links);
    return new Response('OK', { 
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'text/plain' }
    });
  } catch (e) {
    return new Response('Save Error: ' + e.message, { 
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

// IP 缓存，避免重复查询
const ipCache = new Map();

// 国家代码到中文的映射（常用）
const countryCodeMap = {
  'CN': '中国', 'US': '美国', 'JP': '日本', 'KR': '韩国', 'SG': '新加坡',
  'HK': '香港', 'TW': '台湾', 'GB': '英国', 'DE': '德国', 'FR': '法国',
  'RU': '俄罗斯', 'CA': '加拿大', 'AU': '澳大利亚', 'IN': '印度', 'BR': '巴西',
  'NL': '荷兰', 'SE': '瑞典', 'CH': '瑞士', 'IT': '意大利', 'ES': '西班牙',
  'PL': '波兰', 'TR': '土耳其', 'ID': '印尼', 'VN': '越南', 'TH': '泰国',
  'MY': '马来西亚', 'PH': '菲律宾', 'UA': '乌克兰', 'MX': '墨西哥', 'AE': '阿联酋',
  'ZA': '南非', 'SA': '沙特', 'AR': '阿根廷', 'BE': '比利时', 'AT': '奥地利',
  'IL': '以色列', 'IE': '爱尔兰', 'PT': '葡萄牙', 'FI': '芬兰', 'NO': '挪威',
  'DK': '丹麦', 'CZ': '捷克', 'HU': '匈牙利', 'RO': '罗马尼亚', 'BG': '保加利亚',
  'SK': '斯洛伐克', 'LT': '立陶宛', 'LV': '拉脱维亚', 'EE': '爱沙尼亚', 'HR': '克罗地亚',
  'SI': '斯洛文尼亚', 'GR': '希腊', 'IS': '冰岛', 'LU': '卢森堡', 'MT': '马耳他',
  'CY': '塞浦路斯', 'LI': '列支敦士登', 'MC': '摩纳哥', 'AD': '安道尔', 'SM': '圣马力诺',
  'VA': '梵蒂冈', 'MD': '摩尔多瓦', 'BY': '白俄罗斯', 'GE': '格鲁吉亚', 'AM': '亚美尼亚',
  'AZ': '阿塞拜疆', 'KZ': '哈萨克斯坦', 'UZ': '乌兹别克', 'KG': '吉尔吉斯', 'TJ': '塔吉克',
  'TM': '土库曼', 'MN': '蒙古', 'KP': '朝鲜', 'BD': '孟加拉', 'LK': '斯里兰卡',
  'NP': '尼泊尔', 'BT': '不丹', 'MV': '马尔代夫', 'PK': '巴基斯坦', 'AF': '阿富汗',
  'IR': '伊朗', 'IQ': '伊拉克', 'SY': '叙利亚', 'LB': '黎巴嫩', 'JO': '约旦',
  'PS': '巴勒斯坦', 'KW': '科威特', 'QA': '卡塔尔', 'BH': '巴林', 'OM': '阿曼',
  'YE': '也门', 'MO': '澳门'
};

// 查询 IP 地区信息（仅使用 uapis.cn 主接口）
async function getIpLocation(ip) {
  // 清理 IP（去掉端口等）
  const cleanIp = ip.split(':')[0].trim();
  
  // 检查缓存
  if (ipCache.has(cleanIp)) {
    return ipCache.get(cleanIp);
  }
  
  try {
    const response = await fetch(`https://uapis.cn/api/v1/network/ipinfo?ip=${cleanIp}`, {
      cf: { cacheTtl: 86400 }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    // region 可能是 "中国 上海 浦东"、"美国  "、或 "  "（空格）
    if (data.region) {
      const region = data.region.trim();
      if (region) {
        // 提取国家代码
        let code = 'UN';
        for (const [k, v] of Object.entries(countryCodeMap)) {
          if (region.includes(v)) {
            code = k;
            break;
          }
        }
        // 如果无法匹配，根据常见特征判断
        if (code === 'UN') {
          if (/^(美国|USA?|United States)/.test(region)) code = 'US';
          else if (/^(日本|Japan|JP)/.test(region)) code = 'JP';
          else if (/^(韩国|Korea|KR)/.test(region)) code = 'KR';
          else if (/^(新加坡|Singapore|SG)/.test(region)) code = 'SG';
          else if (/^(香港|Hong Kong|HK)/.test(region)) code = 'HK';
          else if (/^(台湾|Taiwan|TW)/.test(region)) code = 'TW';
          else if (/^(英国|United Kingdom|GB|UK)/.test(region)) code = 'GB';
          else if (/^(德国|Germany|DE)/.test(region)) code = 'DE';
          else if (/^(法国|France|FR)/.test(region)) code = 'FR';
          else if (/^(俄罗斯|Russia|RU)/.test(region)) code = 'RU';
          else if (/^(加拿大|Canada|CA)/.test(region)) code = 'CA';
          else if (/^(澳大利亚|Australia|AU)/.test(region)) code = 'AU';
          else if (/^(中国|China|CN)/.test(region)) code = 'CN';
        }
        // 返回格式：代码 + 国家名（从映射表取，不在映射表则取region第一部分）
        const countryName = countryCodeMap[code] || region.split(/\s+/)[0];
        const result = `${code}${countryName}`;
        ipCache.set(cleanIp, result);
        return result;
      }
    }
    throw new Error('No region data');
  } catch (e) {
    const result = 'UN未知';
    ipCache.set(cleanIp, result);
    return result;
  }
}

// 从行中提取 IP 地址
function extractIp(line) {
  // 匹配 IPv4 地址
  const ipv4Match = line.match(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(:\d+)?\b/);
  if (ipv4Match) {
    return ipv4Match[1] + (ipv4Match[2] || '');
  }
  
  // 匹配 IPv6 地址（简化匹配，匹配方括号包裹的 IPv6）
  const ipv6Match = line.match(/\[([0-9a-fA-F:]+)\]/);
  if (ipv6Match) {
    return ipv6Match[1];
  }
  
  // 匹配裸 IPv6 地址（至少包含两个冒号）
  const ipv6BareMatch = line.match(/\b([0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4}){2,})\b/);
  if (ipv6BareMatch) {
    return ipv6BareMatch[1];
  }
  
  return null;
}

// /fetch 结果获取：直接返回已保存的结果，不触发任务
async function handleFetchResult(env, corsHeaders) {
  const lastResult = await env.LINKS_KV.get('last_result');
  
  if (!lastResult) {
    return new Response('', {
      status: 204,
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache'
      }
    });
  }
  
  return new Response(lastResult, {
    status: 200,
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache'
    }
  });
}

// 实际执行 fetch 聚合和 IP 查询的异步流程
async function runFetchProcess(env) {
  try {
    const result = await doFetchAndProcess(env);
    await env.LINKS_KV.put('last_result', result);
    await env.LINKS_KV.put('last_result_time', new Date().toISOString());
  } catch (e) {
    console.error('Fetch process error:', e);
    // 失败时不删除旧内容，保持 last_result 不变
  } finally {
    await env.LINKS_KV.put('fetch_processing', '0');
  }
}

// 核心处理逻辑：获取链接、聚合、IP 查询
async function doFetchAndProcess(env) {
  const links = await env.LINKS_KV.get('links');
  if (!links || !links.trim()) {
    throw new Error('No links configured');
  }

  const urls = links.split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));

  if (urls.length === 0) {
    throw new Error('No valid links found');
  }

  const seen = new Set();
  const allLines = [];
  let successCount = 0;
  const errors = [];

  for (const url of urls) {
    try {
      const response = await fetch(url, {
        headers: { 
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        cf: { cacheTtl: 60 }
      });
      
      if (!response.ok) {
        errors.push(`# Error: HTTP ${response.status} for ${url}`);
        continue;
      }
      
      const text = await response.text();
      successCount++;
      
      const lines = text.split('\n');
      for (const line of lines) {
        const idx = line.indexOf('#');
        const processed = idx >= 0 ? line.substring(0, idx).trim() : line.trim();
        
        if (processed && !seen.has(processed)) {
          seen.add(processed);
          allLines.push(processed);
        }
      }
    } catch (e) {
      errors.push(`# Error fetching ${url}: ${e.message}`);
    }
  }

  if (successCount === 0) {
    throw new Error('All links failed');
  }

  // 队列方式处理 IP 地区查询：失败则跳过，记录失败项
  const processedLines = [];
  const failedIps = []; // { line, ip }

  for (const line of allLines) {
    const ip = extractIp(line);
    if (ip) {
      try {
        const location = await getIpLocation(ip);
        if (location === 'UN未知') {
          // 标记为失败，稍后重试
          failedIps.push({ line, ip });
          processedLines.push(`${line} #${location}`);
        } else {
          processedLines.push(`${line} #${location}`);
        }
      } catch (e) {
        failedIps.push({ line, ip });
        processedLines.push(`${line} #UN未知`);
      }
    } else {
      processedLines.push(line);
    }
  }

  // 队列完成后，重新请求之前失败的 IP
  if (failedIps.length > 0) {
    for (const item of failedIps) {
      try {
        // 清除缓存，强制重新查询
        const cleanIp = item.ip.split(':')[0].trim();
        ipCache.delete(cleanIp);
        const location = await getIpLocation(item.ip);
        // 更新对应行
        const idx = processedLines.findIndex(pl => pl.startsWith(item.line + ' #'));
        if (idx >= 0) {
          processedLines[idx] = `${item.line} #${location}`;
        }
      } catch (e) {
        // 重试失败，保持原样
      }
    }
  }

  let output = processedLines.join('\n');
  if (errors.length > 0) {
    output += '\n\n' + errors.join('\n');
  }

  return output;
}

// 返回最近一次完成结果的状态
async function handleStatus(env, corsHeaders) {
  const lastTime = await env.LINKS_KV.get('last_result_time') || '';
  const lastResult = await env.LINKS_KV.get('last_result') || '';
  const processing = await env.LINKS_KV.get('fetch_processing') || '0';
  const processingStart = await env.LINKS_KV.get('fetch_processing_start') || '';
  
  const data = {
    lastResultTime: lastTime,
    hasResult: !!lastResult,
    processing: processing === '1',
    processingStart: processingStart
  };
  
  return new Response(JSON.stringify(data), {
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json; charset=utf-8'
    }
  });
}

async function handleAdmin(env) {
  const existing = await env.LINKS_KV.get('links') || '';
  
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>链接聚合管理</title>
  <style>
    * { box-sizing: border-box; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
      max-width: 900px; 
      margin: 40px auto; 
      padding: 20px; 
      background: #f5f5f5;
      line-height: 1.6;
    }
    .container {
      background: white;
      padding: 30px;
      border-radius: 12px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
    }
    h1 { margin-top: 0; color: #333; }
    .info {
      background: #e3f2fd;
      padding: 15px;
      border-radius: 8px;
      margin-bottom: 20px;
      font-size: 14px;
      color: #1565c0;
    }
    .info code {
      background: #fff;
      padding: 2px 6px;
      border-radius: 4px;
      font-family: monospace;
      border: 1px solid #bbdefb;
    }
    .status-bar {
      background: #f3e5f5;
      padding: 12px 15px;
      border-radius: 8px;
      margin-bottom: 20px;
      font-size: 14px;
      color: #6a1b9a;
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .status-bar .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #9c27b0;
      display: inline-block;
    }
    .status-bar .time {
      font-weight: 600;
    }
    .status-bar .processing {
      color: #e65100;
      font-weight: 500;
      display: none;
    }
    .status-bar .processing.active {
      display: inline;
    }
    .status-bar .trigger-btn {
      margin-left: auto;
      padding: 6px 16px;
      background: #4caf50;
      color: white;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      transition: all 0.2s;
    }
    .status-bar .trigger-btn:hover { background: #43a047; }
    .status-bar .trigger-btn:disabled { background: #ccc; cursor: not-allowed; }
    textarea { 
      width: 100%; 
      height: 350px; 
      font-family: monospace; 
      font-size: 14px;
      padding: 12px;
      border: 1px solid #ddd;
      border-radius: 8px;
      resize: vertical;
      line-height: 1.5;
    }
    textarea:focus {
      outline: none;
      border-color: #2196f3;
      box-shadow: 0 0 0 3px rgba(33,150,243,0.1);
    }
    .button-row {
      margin-top: 15px;
      display: flex;
      gap: 10px;
      align-items: center;
    }
    button { 
      padding: 12px 28px; 
      cursor: pointer;
      background: #2196f3;
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 500;
      transition: all 0.2s;
    }
    button:hover { background: #1976d2; }
    button:disabled { background: #ccc; cursor: not-allowed; }
    .status { 
      padding: 12px 16px; 
      border-radius: 8px;
      font-size: 14px;
      display: none;
    }
    .success { background: #e8f5e9; color: #2e7d32; border: 1px solid #a5d6a7; }
    .error { background: #ffebee; color: #c62828; border: 1px solid #ef9a9a; }
    .tips {
      margin-top: 25px;
      padding: 20px;
      background: #fff8e1;
      border-radius: 8px;
      font-size: 14px;
      color: #5d4037;
    }
    .tips h3 { margin-top: 0; }
    .tips ul { margin: 10px 0; padding-left: 20px; }
    .tips li { margin: 6px 0; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🔗 链接聚合管理</h1>
    
    <div class="info">
      <strong>API 端点：</strong>程序请访问 <code>/fetch</code> 获取已聚合的结果（无结果时返回空）<br>
      <strong>状态查询：</strong>访问 <code>/status</code> 查询处理状态和最近一次完成时间<br>
      <strong>智能访问：</strong>直接 curl 根域名也会返回聚合结果<br>
      <strong>自动去重：</strong>多个链接返回的相同内容会自动去重，保留首次出现的顺序<br>
      <strong>自动更新：</strong>每整半小时自动触发后台聚合，新结果完成后替换旧结果（处理中保留旧内容）
    </div>
    
    <div class="status-bar" id="statusBar">
      <span class="dot"></span>
      <span>最近一次完成结果时间：</span>
      <span class="time" id="lastTime">加载中...</span>
      <span class="processing" id="processingTag">⏳ 处理中...</span>
    </div>
    
    <p>在下方输入框中填写链接，每行一个：</p>
    <textarea id="links" placeholder="https://example.com/list1&#10;https://example.com/list2&#10;https://example.com/list3">${existing}</textarea>
    
    <div class="button-row">
      <button onclick="save()" id="saveBtn">保存链接</button>
      <div id="status" class="status"></div>
    </div>
    
    <div class="tips">
      <h3>使用说明</h3>
      <ul>
        <li>每行只能填写一个链接</li>
        <li>以 <code>#</code> 开头的行会被视为注释，跳过不处理</li>
        <li>访问 <code>/fetch</code> 时，直接返回最近一次已完成的聚合结果（无结果时返回空）</li>
        <li>结果由定时任务每整半小时自动更新，新结果完成后替换旧结果</li>
        <li>获取到的内容会自动删除每行原有的 <code>#</code> 后的文字（包括 <code>#</code> 本身）</li>
        <li>多个链接返回的<strong>相同内容会自动去重</strong>，保留首次出现的顺序</li>
        <li><strong>新增：</strong>自动识别每行中的 IP 地址，并在末尾追加 <code>#国家简拼国家名</code> 的地区信息</li>
        <li>示例输出：<code>192.168.1.1:8080 #CN中国</code></li>
        <li><strong>新增：</strong>IP 查询改为队列模式，失败后自动重试，确保稳定性</li>
      </ul>
    </div>
  </div>
  
  <script>
    async function save() {
      const btn = document.getElementById('saveBtn');
      const status = document.getElementById('status');
      const links = document.getElementById('links').value;
      
      btn.disabled = true;
      status.style.display = 'none';
      
      try {
        const res = await fetch('/save', {
          method: 'POST',
          headers: {'Content-Type': 'text/plain'},
          body: links
        });
        
        if (res.ok) {
          status.className = 'status success';
          status.textContent = '✓ 保存成功';
        } else {
          const text = await res.text();
          status.className = 'status error';
          status.textContent = '✗ 保存失败: ' + text;
        }
      } catch (e) {
        status.className = 'status error';
        status.textContent = '✗ 错误: ' + e.message;
      }
      
      status.style.display = 'block';
      btn.disabled = false;
    }
    
    // 加载状态信息
    async function loadStatus() {
      try {
        const res = await fetch('/status');
        if (res.ok) {
          const data = await res.json();
          const timeEl = document.getElementById('lastTime');
          const procEl = document.getElementById('processingTag');
          
          if (data.lastResultTime) {
            const date = new Date(data.lastResultTime);
            timeEl.textContent = date.toLocaleString('zh-CN');
          } else {
            timeEl.textContent = '暂无记录';
          }
          
          if (data.processing) {
            procEl.classList.add('active');
          } else {
            procEl.classList.remove('active');
          }
        }
      } catch (e) {
        document.getElementById('lastTime').textContent = '获取失败';
      }
    }
    
    loadStatus();
    // 每 10 秒刷新一次状态
    setInterval(loadStatus, 10000);
  </script>
</body>
</html>`;
  
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}
