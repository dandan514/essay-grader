/**
 * 智能英语作文批改系统 - 后端服务
 * 功能：
 *   1. 百度智能云手写文字识别（OCR）
 *   2. Deepseek AI 作文智能批改
 *   3. 静态文件服务（前端页面）
 */

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// 配置 multer 用于文件上传（内存存储，直接转base64）
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 限制10MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|bmp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    if (extname && mimetype) {
      return cb(null, true);
    }
    cb(new Error('只支持图片格式：JPG、PNG、GIF、BMP'));
  }
});

// 中间件
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 缓存百度 access_token，避免频繁获取
let baiduAccessToken = null;
let baiduTokenExpireTime = 0;

/**
 * 获取百度智能云 access_token
 * @returns {Promise<string>} access_token
 */
async function getBaiduAccessToken() {
  const now = Date.now();
  // token 还有效时直接返回（提前5分钟过期以防万一）
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

/**
 * 调用百度手写文字识别 API
 * @param {Buffer} imageBuffer 图片缓冲区
 * @returns {Promise<string>} 识别出的文字内容
 */
async function baiduHandwritingOCR(imageBuffer) {
  const accessToken = await getBaiduAccessToken();
  const apiUrl = `https://aip.baidubce.com/rest/2.0/ocr/v1/handwriting?access_token=${accessToken}`;

  const base64Img = imageBuffer.toString('base64');
  const body = new URLSearchParams();
  body.append('image', base64Img);

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

  // 拼接所有识别的文字行
  const words = data.words_result || [];
  const text = words.map(item => item.words).join('\n');

  return {
    text: text,
    wordCount: words.length,
    rawResult: data
  };
}

/**
 * 调用 Deepseek AI 进行作文批改
 * @param {string} essayText 学生作文文本
 * @returns {Promise<object>} 批改结果
 */
async function gradeEssayWithAI(essayText) {
  const apiKey = process.env.DEEPSEEK_API_KEY;

  if (!apiKey) {
    throw new Error('Deepseek API Key 未配置');
  }

  // 构建评分标准 prompt
  const systemPrompt = `你是一位专业的初中英语老师，负责批改学生的英语作文。请严格按照以下评分标准进行批改。

【作文题目】Should friends be similar or different?（朋友应该与自己相似还是不同？还是不介意？）
学生可以从以下三个立场中选择一个来写：
1. 认为朋友应该相似（类似 Matt 的观点：朋友如镜子，有共同爱好，互相促进）
2. 认为朋友应该不同（类似 Diana 的观点：不同的朋友让自己变得更好，互相学习）
3. 不介意朋友是否相似（类似 Rose 的观点：真正的朋友无关相似与否，重要的是真心相待）

【评分标准（满分10分）】

一、Content 内容（6分）
1. Opinion (Topic sentence) - 1分
   - 开头是否有明确的主题句，表明自己的观点立场
   
2. Reasons - 1分
   - 是否给出了支持自己观点的理由
   
3. Examples - 3分
   - 是否有具体的例子来支撑观点（至少1个具体例子得1分，2个例子得2分，3个及以上或例子详细生动得3分）
   
4. Opinion (Saying) - 1分
   - 结尾是否有总结句或引用名言/谚语来重申观点

二、Structure 结构（2分）
1. More than two paragraphs (超过2段) - 1分
   - 文章是否分段合理，至少3段（开头、主体、结尾）
   
2. More than two linking words (超过2个连接词) - 1分
   - 是否使用了连接词（如 and, but, besides, what's more, however, for example, because, so 等），至少使用3个以上

三、Language 语言（2分）
1. Use comparatives (使用比较级) - 2分
   - 是否正确使用了形容词/副词比较级（如 than, as...as..., more...than, better than 等）
   - 正确使用2个及以上得2分，正确使用1个得1分，完全没有或全错得0分

【扣分规则】
- 每个要点内如果出现语法错误，视错误严重程度扣0.2-0.5分
- 语法错误包括：时态错误、主谓不一致、拼写错误、词性错误、介词错误、冠词错误等
- 如果缺少某个要点，该要点分数全扣
- 同一类型的语法错误反复出现，可累计扣分但不超过该要点分值

【输出格式要求】
请严格按照以下 JSON 格式输出（不要输出其他多余文字，只输出 JSON）：
{
  "totalScore": 总分（数字，如 7.5）,
  "maxScore": 10,
  "contentScore": {
    "topicSentence": { "score": 得分, "maxScore": 1, "comment": "评语" },
    "reasons": { "score": 得分, "maxScore": 1, "comment": "评语" },
    "examples": { "score": 得分, "maxScore": 3, "comment": "评语" },
    "saying": { "score": 得分, "maxScore": 1, "comment": "评语" }
  },
  "structureScore": {
    "paragraphs": { "score": 得分, "maxScore": 1, "comment": "评语" },
    "linkingWords": { "score": 得分, "maxScore": 1, "comment": "评语" }
  },
  "languageScore": {
    "comparatives": { "score": 得分, "maxScore": 2, "comment": "评语" }
  },
  "grammarErrors": [
    {
      "original": "原文中的错误句子或短语",
      "corrected": "修改后的正确表达",
      "explanation": "错误原因说明（中文）",
      "deduction": 扣分数值（如 0.3）
    }
  ],
  "missingPoints": [
    "缺少的要点列表（中文描述）"
  ],
  "overallComment": "总体评价（中文，50-100字，先肯定优点，再指出不足，最后给出建议）",
  "suggestions": [
    "具体的修改建议列表（中文，3-5条）"
  ]
}`;

  const userPrompt = `请批改以下学生作文：

--- 作文开始 ---
${essayText}
--- 作文结束 ---

请严格按照评分标准进行批改，并以 JSON 格式输出结果。`;

  const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.3,
      max_tokens: 2000,
      response_format: { type: 'json_object' }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Deepseek API 调用失败：${response.status} - ${errorText}`);
  }

  const data = await response.json();
  const content = data.choices[0]?.message?.content || '{}';

  // 尝试解析 JSON
  try {
    const result = JSON.parse(content);
    return result;
  } catch (parseError) {
    // 如果解析失败，尝试提取 JSON 部分
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch (e) {
        throw new Error('AI 返回结果解析失败');
      }
    }
    throw new Error('AI 返回结果格式不正确');
  }
}

// ============ API 路由 ============

/**
 * OCR 文字识别接口
 * POST /api/ocr
 * body: form-data 中的 image 字段（图片文件）
 */
app.post('/api/ocr', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: '请上传图片文件' });
    }

    console.log('收到 OCR 请求，图片大小：', req.file.size, '字节');

    const result = await baiduHandwritingOCR(req.file.buffer);

    res.json({
      success: true,
      text: result.text,
      wordCount: result.wordCount
    });
  } catch (error) {
    console.error('OCR 识别错误：', error.message);
    res.status(500).json({
      success: false,
      error: error.message || '文字识别失败'
    });
  }
});

/**
 * 作文批改接口
 * POST /api/grade
 * body: { text: "作文文本" }
 */
app.post('/api/grade', async (req, res) => {
  try {
    const { text } = req.body;

    if (!text || text.trim().length < 10) {
      return res.status(400).json({
        success: false,
        error: '作文内容太短，请确保识别正确后再提交批改'
      });
    }

    console.log('收到批改请求，作文长度：', text.length, '字符');

    const result = await gradeEssayWithAI(text);

    res.json({
      success: true,
      result: result
    });
  } catch (error) {
    console.error('作文批改错误：', error.message);
    res.status(500).json({
      success: false,
      error: error.message || '作文批改失败'
    });
  }
});

/**
 * 健康检查接口
 */
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status: 'running',
    timestamp: new Date().toISOString()
  });
});

// 启动服务器
app.listen(PORT, () => {
  console.log(`🚀 智能作文批改系统已启动`);
  console.log(`📍 本地访问：http://localhost:${PORT}`);
  console.log(`📅 启动时间：${new Date().toLocaleString('zh-CN')}`);
});
