export default {
  async fetch(request, env, ctx) {
    // 全局兜底：任何异常都返回可读信息，避免 1101
    try {
      return await handleRequest(request, env);
    } catch (e) {
      return new Response(
        `Worker Error: ${e.message}\n\nStack:\n${e.stack || 'none'}`, 
        { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
      );
    }
  },

  // 整点半自动触发聚合（需在 wrangler.toml 配置 crons = ["*/30 * * * *"]）
  async scheduled(event, env, ctx) {
    try {
      console.log('[Scheduled] Aggregation started at', new Date().toISOString());
      const output = await aggregateLinks(env);
      await env.LINKS_KV.put('cached_aggregate', output, { expirationTtl: 3600 });
      console.log('[Scheduled] Aggregation completed, cached successfully.');
    } catch (e) {
      console.error('[Scheduled] Aggregation failed:', e.message);
    }
  }
};

async function handleRequest(request, env) {
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
    return handleFetch(env, corsHeaders);
  }

  if (url.pathname === '/' || url.pathname === '') {
    const accept = request.headers.get('Accept') || '';
    const userAgent = request.headers.get('User-Agent') || '';
    const isBrowser = accept.includes('text/html') || 
      /Mozilla|Chrome|Safari|Firefox|Edge/.test(userAgent);
    
    if (isBrowser) {
      return handleAdmin(env);
    } else {
      return handleFetch(env, corsHeaders);
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
    
    // 保存后自动刷新缓存
    try {
      const output = await aggregateLinks(env);
      await env.LINKS_KV.put('cached_aggregate', output, { expirationTtl: 3600 });
    } catch (e) {
      console.error('Auto refresh after save failed:', e.message);
    }
    
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

// ==================== 核心聚合逻辑（抽离为独立函数） ====================

async function aggregateLinks(env) {
  const links = await env.LINKS_KV.get('links');
  if (!links || !links.trim()) {
    throw new Error('No links configured. Please open this page in browser and add links first.');
  }
  
  const urls = links.split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));
  
  if (urls.length === 0) {
    throw new Error('No valid links found (all lines are empty or comments).');
  }

  const seen = new Set();
  const allLines = [];
  let successCount = 0;
  const errors = [];

  // 1. 拉取所有上游链接
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
    const errorOutput = errors.join('\n') || 'All links failed';
    throw new Error(errorOutput);
  }

  // 2. IP 归属地标注（两轮机制：先查询，失败则入队重试）
  const processedLines = new Array(allLines.length);
  const retryQueue = []; // { index, ip, originalLine }

  // 第一轮：常规查询
  for (let i = 0; i < allLines.length; i++) {
    const line = allLines[i];
    const ip = extractIp(line);
    
    if (ip) {
      const location = await getIpLocation(ip);
      if (location === 'UN未知') {
        // 查询失败，跳过标注，加入重试队列
        retryQueue.push({ index: i, ip, originalLine: line });
        processedLines[i] = line; // 暂时保持原样，不添加注释
      } else {
        processedLines[i] = `${line} #${location}`;
      }
    } else {
      processedLines[i] = line;
    }
  }

  // 第二轮：对未成功的 IP 重新查询
  if (retryQueue.length > 0) {
    console.log(`[Retry] ${retryQueue.length} IPs need retry...`);
    for (const item of retryQueue) {
      const cleanIp = item.ip.split(':')[0].trim();
      ipCache.delete(cleanIp); // 清除缓存，强制重新走 API
      const location = await getIpLocation(item.ip);
      
      if (location === 'UN未知') {
        processedLines[item.index] = `${item.originalLine} #UN未知`;
      } else {
        processedLines[item.index] = `${item.originalLine} #${location}`;
        console.log(`[Retry] Success for ${cleanIp}: ${location}`);
      }
    }
  }

  // 3. 组装输出
  let output = processedLines.join('\n');
  if (errors.length > 0) {
    output += '\n\n' + errors.join('\n');
  }

  return output;
}

// ==================== /fetch 端点（优先读缓存） ====================

async function handleFetch(env, corsHeaders) {
  // 优先返回缓存结果（由定时任务或上次保存时生成）
  const cached = await env.LINKS_KV.get('cached_aggregate');
  if (cached !== null && cached.trim() !== '') {
    return new Response(cached, {
      headers: { 
        ...corsHeaders, 
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Cache-Status': 'HIT'
      }
    });
  }
  
  // 缓存未命中（首次部署或缓存过期），实时聚合
  try {
    const output = await aggregateLinks(env);
    // 实时聚合成功后也写入缓存
    await env.LINKS_KV.put('cached_aggregate', output, { expirationTtl: 3600 });
    return new Response(output, {
      headers: { 
        ...corsHeaders, 
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Cache-Status': 'MISS'
      }
    });
  } catch (e) {
    return new Response(e.message, { 
      status: 502,
      headers: { ...corsHeaders, 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

// ==================== IP 查询相关（保持原有逻辑） ====================

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

// 查询 IP 地区信息（使用 uapis.cn 作为首选接口）
async function getIpLocation(ip) {
  // 清理 IP（去掉端口等）
  const cleanIp = ip.split(':')[0].trim();
  
  // 检查缓存
  if (ipCache.has(cleanIp)) {
    return ipCache.get(cleanIp);
  }
  
  // 依次尝试多个 API
  const apis = [
    // uapis.cn - 首选，返回中文地区信息更完整
    async () => {
      const response = await fetch(`https://uapis.cn/api/v1/network/ipinfo?ip=${cleanIp}`, {
        cf: { cacheTtl: 86400 }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (data.region) {
        const region = data.region.trim();
        if (region) {
          let code = 'UN';
          for (const [k, v] of Object.entries(countryCodeMap)) {
            if (region.includes(v)) {
              code = k;
              break;
            }
          }
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
          const countryName = countryCodeMap[code] || region.split(/\s+/)[0];
          return `${code}${countryName}`;
        }
      }
      throw new Error('No region data');
    },
    // ipapi.co - 备选
    async () => {
      const response = await fetch(`https://ipapi.co/${cleanIp}/json/`, {
        cf: { cacheTtl: 86400 }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (data.country_code) {
        const code = data.country_code;
        return `${code}${countryCodeMap[code] || data.country_name || '未知'}`;
      }
      throw new Error('No country data');
    },
    // ipinfo.io - 备选
    async () => {
      const response = await fetch(`https://ipinfo.io/${cleanIp}/json`, {
        cf: { cacheTtl: 86400 }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (data.country) {
        const code = data.country;
        return `${code}${countryCodeMap[code] || '未知'}`;
      }
      throw new Error('No country data');
    },
    // ip-api.com - 最后备选
    async () => {
      const response = await fetch(`http://ip-api.com/json/${cleanIp}?fields=status,country,countryCode,message&lang=zh-CN`, {
        cf: { cacheTtl: 86400 }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (data.status === 'success' && data.countryCode) {
        const code = data.countryCode;
        return `${code}${countryCodeMap[code] || data.country || '未知'}`;
      }
      throw new Error(data.message || 'API failed');
    }
  ];
  
  for (const api of apis) {
    try {
      const result = await api();
      if (result === 'UN未知') {
        continue;
      }
      ipCache.set(cleanIp, result);
      return result;
    } catch (e) {
      continue;
    }
  }
  
  const result = 'UN未知';
  ipCache.set(cleanIp, result);
  return result;
}

// 从行中提取 IP 地址
function extractIp(line) {
  const ipv4Match = line.match(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(:\d+)?\b/);
  if (ipv4Match) {
    return ipv4Match[1] + (ipv4Match[2] || '');
  }
  
  const ipv6Match = line.match(/\[([0-9a-fA-F:]+)\]/);
  if (ipv6Match) {
    return ipv6Match[1];
  }
  
  const ipv6BareMatch = line.match(/\b([0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4}){2,})\b/);
  if (ipv6BareMatch) {
    return ipv6BareMatch[1];
  }
  
  return null;
}

// ==================== 管理后台 HTML ====================

async function handleAdmin(env) {
  const existing = await env.LINKS_KV.get('links') || '';
  const cached = await env.LINKS_KV.get('cached_aggregate');
  let cacheInfo = '暂无缓存';
  if (cached !== null) {
    const lines = cached.split('\n').filter(l => l.trim() && !l.startsWith('#')).length;
    cacheInfo = `已缓存（约 ${lines} 条记录）`;
  }
  
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
    .cache-status {
      background: #f3e5f5;
      padding: 12px 15px;
      border-radius: 8px;
      margin-bottom: 20px;
      font-size: 14px;
      color: #6a1b9a;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .cache-status::before {
      content: "⏱";
      font-size: 16px;
    }
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
      flex-wrap: wrap;
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
    .refresh-btn {
      background: #4caf50;
    }
    .refresh-btn:hover {
      background: #388e3c;
    }
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
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 600;
      margin-left: 6px;
    }
    .badge-new {
      background: #ff5722;
      color: white;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🔗 链接聚合管理</h1>
    
    <div class="info">
      <strong>API 端点：</strong>程序请访问 <code>/fetch</code> 获取汇总后的内容<br>
      <strong>智能访问：</strong>直接 curl 根域名也会自动返回汇总内容<br>
      <strong>自动去重：</strong>多个链接返回的相同内容会自动去重，保留首次出现的顺序<br>
      <strong>IP 地区分析：</strong>自动识别每行中的 IP 地址并标注所属国家（如 <code>#CN中国</code>）
    </div>

    <div class="cache-status">
      <strong>缓存状态：</strong>${cacheInfo} &nbsp;|&nbsp; 每整半小时自动更新（00:00 / 00:30 / 01:00 ...）
    </div>
    
    <p>在下方输入框中填写链接，每行一个：</p>
    <textarea id="links" placeholder="https://example.com/list1&#10;https://example.com/list2&#10;https://example.com/list3">${existing}</textarea>
    
    <div class="button-row">
      <button onclick="save()" id="saveBtn">保存链接</button>
      <button onclick="refreshCache()" id="refreshBtn" class="refresh-btn">立即刷新缓存</button>
      <div id="status" class="status"></div>
    </div>
    
    <div class="tips">
      <h3>使用说明</h3>
      <ul>
        <li>每行只能填写一个链接</li>
        <li>以 <code>#</code> 开头的行会被视为注释，跳过不处理</li>
        <li>访问 <code>/fetch</code> 时，程序会优先返回缓存内容，响应速度极快</li>
        <li>获取到的内容会自动删除每行原有的 <code>#</code> 后的文字（包括 <code>#</code> 本身）</li>
        <li>多个链接返回的<strong>相同内容会自动去重</strong>，保留首次出现的顺序</li>
        <li><strong>新增：</strong>自动识别每行中的 IP 地址，并在末尾追加 <code>#国家简拼国家名</code> 的地区信息</li>
        <li><span class="badge badge-new">NEW</span> <strong>IP 重试机制：</strong>若某 IP 首次查询归属地失败，会先跳过该 IP 继续处理其他行，待全部处理完成后重新查询失败的 IP，提高成功率</li>
        <li><span class="badge badge-new">NEW</span> <strong>自动缓存：</strong>每整半小时自动聚合所有链接并更新缓存；保存链接后也会自动刷新缓存</li>
        <li>示例输出：<code>192.168.1.1:8080 #CN中国</code></li>
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
          status.textContent = '✓ 保存成功，缓存已自动刷新';
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

    async function refreshCache() {
      const btn = document.getElementById('refreshBtn');
      const status = document.getElementById('status');
      
      btn.disabled = true;
      status.style.display = 'none';
      status.textContent = '刷新中...';
      status.className = 'status';
      status.style.display = 'block';
      
      try {
        const res = await fetch('/fetch');
        if (res.ok) {
          status.className = 'status success';
          status.textContent = '✓ 缓存刷新成功';
        } else {
          const text = await res.text();
          status.className = 'status error';
          status.textContent = '✗ 刷新失败: ' + text;
        }
      } catch (e) {
        status.className = 'status error';
        status.textContent = '✗ 错误: ' + e.message;
      }
      
      btn.disabled = false;
    }
  </script>
</body>
</html>`;
  
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}
