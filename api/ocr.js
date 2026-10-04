/**
 * Vercel Serverless Function - OCR 文字识别
 * POST /api/ocr
 * 接收 base64 图片数据，调用百度智能云手写文字识别 API
 */

// 缓存百度 access_token（Serverless 环境下缓存可能不生效，但不影响功能）
let baiduAccessToken = null;
let baiduTokenExpireTime = 0;

/**
 * 获取百度智能云 access_token
 */
async function getBaiduAccessToken() {
  const now = Date.now();
  if (baiduAccessToken && now < baiduTokenExpireTime - 5 * 60 * 1000) {
    return baiduAccessToken;
  }

  const apiKey = process.env.BAIDU_API_KEY;
  const secretKey = process.env.BAIDU_SECRET_KEY;

  if (!apiKey || !secretKey) {
    throw new Error('百度智能云 API Key 或 Secret Key 未配置');
  }

  const tokenUrl = `https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=${apiKey}&client_secret=${secretKey}`;

  const response = await fetch(tokenUrl, { method: 'POST' });
  const data = await response.json();

  if (data.error) {
    throw new Error(`获取百度 token 失败：${data.error_description || data.error}`);
  }

  baiduAccessToken = data.access_token;
  baiduTokenExpireTime = now + data.expires_in * 1000;
  return baiduAccessToken;
}

module.exports = async function handler(req, res) {
  // 允许跨域
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: '只支持 POST 请求' });
  }

  try {
    const { imageBase64 } = req.body || {};

    if (!imageBase64) {
      return res.status(400).json({ success: false, error: '请上传图片文件' });
    }

    // 去掉 data:image/xxx;base64, 前缀
    const cleanBase64 = imageBase64.replace(/^data:image\/[a-z]+;base64,/, '');
    const imageBuffer = Buffer.from(cleanBase64, 'base64');

    console.log('OCR 请求，图片大小：', imageBuffer.length, '字节');

    const accessToken = await getBaiduAccessToken();
    const apiUrl = `https://aip.baidubce.com/rest/2.0/ocr/v1/handwriting?access_token=${accessToken}`;

    const body = new URLSearchParams();
    body.append('image', cleanBase64);

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: body.toString()
    });

    const data = await response.json();

    if (data.error_code) {
      throw new Error(`OCR 识别失败：${data.error_msg || data.error_code}`);
    }

    const words = data.words_result || [];
    const text = words.map(item => item.words).join('\n');

    res.status(200).json({
      success: true,
      text: text,
      wordCount: words.length
    });
  } catch (error) {
    console.error('OCR 错误：', error.message);
    res.status(500).json({
      success: false,
      error: error.message || '文字识别失败'
    });
  }
};
