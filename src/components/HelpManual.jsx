import React from 'react';
import { useI18n } from '../utils/i18n';
import './HelpManual.css';

function buildManualSections(tx) {
  return [
    {
      id: 'scraper',
      title: tx('Style Index', '款号索引'),
      summary: tx(
        'Collects product assets and structured information from supported retail sites.',
        '从支持的零售网站抓取商品素材和结构化信息。',
      ),
      scenarios: [
        tx('You need to collect reference images or product pages from Zara, Bershka, Stradivarius, H&M, UNIQLO, and more.', '你需要从 Zara、Bershka、Stradivarius、H&M、UNIQLO 等站点收集参考图或产品页。'),
        tx('You want to batch-save images and metadata for later analysis, naming, or deck generation.', '你想批量保存图片和资料，后续再做分析、命名或 PPT。'),
      ],
      options: [
        {
          name: tx('URL / SKU driven capture', 'URL / 款号驱动抓取'),
          bestFor: tx('Use URLs when you already know the exact page. Use SKU when you need the app to find the page first.', '已知页面链接就直接用 URL；只有款号时用 SKU 让软件先找页面。'),
          notes: tx('SKU lookup can be slower but is more scalable when you only have internal product lists. Style numbers can be typed in or imported from Excel.', 'SKU 查找会稍慢，但当你只有内部货号列表时更适合批量处理。款号可以手动输入，也可以从 Excel 导入。'),
        },
        {
          name: tx('Local browser (Chrome preferred, then Edge)', '本地浏览器（优先 Chrome，其次 Edge）'),
          bestFor: tx('All scraping now runs in your own installed browser. The app no longer ships a built-in browser.', '所有抓取现在都跑在你本机安装的浏览器里，软件不再内置浏览器。'),
          notes: tx('Pick Chrome or Edge in Settings; Auto uses Chrome first and falls back to Edge. Some sites such as H&M check your real browsing identity, so they require a genuinely installed browser. If none is found, the app tells you what to install instead of downloading one silently.', '在设置里选择 Chrome 或 Edge（自动 = 先 Chrome 后 Edge）。H&M 等站点会校验真实浏览器身份，必须用本机安装的浏览器。找不到浏览器时软件会直接提示安装，不再静默下载。'),
        },
        {
          name: tx('H&M browser identity', 'H&M 浏览器身份'),
          bestFor: tx('Getting an H&M run through on the first try', '让 H&M 抓取第一次就能通过'),
          notes: tx('Fully quit the browser before running so the app can copy your H&M cookies into a dedicated session. Browsing H&M in that browser beforehand makes the identity stronger.', '运行前先完全退出浏览器，软件才能把你的 H&M 身份克隆到专用会话。跑之前先在该浏览器里人肉逛过 H&M，身份会更扎实。'),
        },
      ],
    },
    {
      id: 'slides',
      title: tx('Slides Maker', 'PPT 生成'),
      summary: tx(
        'Turns organized folders or image groups into presentation-ready decks.',
        '把整理好的文件夹或图片分组直接做成可交付的演示文稿。',
      ),
      scenarios: [
        tx('You already have front/back images or fabric images and need a deck quickly.', '你已经有正反面图或面料图，想快速出一份 PPT。'),
        tx('You want the app to reuse organizer metadata instead of re-reading the same labels.', '你想让软件复用图片整理元数据，而不是重复分析同一批标签。'),
      ],
      options: [
        {
          name: tx('Style mode', '款式模式'),
          bestFor: tx('Front/back garment presentations with label details', '正反面款式展示并带标签信息'),
          notes: tx('Builds a deck from style folders (each folder = one style) or a single folder. Reads files named like STYLE_F / STYLE_B and reuses organizer JSON when available.', '从款式文件夹（一个文件夹 = 一个款式）或单文件夹生成画册。读取像 款号_F / 款号_B 这样的命名，已有整理 JSON 时会优先复用。'),
        },
        {
          name: tx('Fabric mode', '面料模式'),
          bestFor: tx('Fabric lookbooks with one fabric per page', '一页一个面料的面料画册'),
          notes: tx('Fixed single-page layout. Good when each fabric already has one hero image and a label source.', '固定单页版式，适合每个面料已有主图和标签来源的情况。'),
        },
        {
          name: tx('AI model source', 'AI 模型来源'),
          bestFor: tx('AI-written style names and descriptions on each page', '让每页的款式名和描述由 AI 生成'),
          notes: tx('Follow Settings, Ollama (Local), Ollama Cloud, or GLM / API Cloud. The concrete model is whatever you configured on the Settings page for that source. Fields the AI leaves blank stay editable for manual filling.', '可选：跟随设置页 / Ollama 本地 / Ollama 云端 / GLM 云端（API）。具体模型就是该来源在设置页配置的那个；AI 没写的字段会留空，方便后续人工补。'),
        },
      ],
    },
    {
      id: 'bestseller',
      title: tx('Brand DNA', '品牌DNA'),
      summary: tx(
        'Pulls a brand\'s best-seller listing and turns it into an AI trend report.',
        '抓取品牌的热门榜单，并生成 AI 趋势报告。',
      ),
      scenarios: [
        tx('You want to know what is currently selling on New Yorker, UNIQLO, H&M, Free People, or Intersport.', '你想了解 New Yorker、UNIQLO、H&M、Free People 或 Intersport 当前什么好卖。'),
        tx('You need trend evidence to back up style, pricing, or naming decisions.', '你需要热门趋势作为款式、价格或命名决策的参考依据。'),
      ],
      options: [
        {
          name: tx('Guided wizard (H&M)', '向导式设置（H&M）'),
          bestFor: tx('First-time or occasional H&M runs', '第一次或偶尔跑 H&M'),
          notes: tx('Pick the brand, pick the browser, then run the check. It only asks you to confirm two things: the browser is fully closed, and your H&M identity was copied successfully. The Next button unlocks once both pass.', '选品牌 → 选浏览器 → 运行检测。只需确认两件事：浏览器已完全退出、H&M 身份克隆成功。两项都通过后「下一步」才会解锁。'),
        },
        {
          name: tx('AI trend report', 'AI 趋势报告'),
          bestFor: tx('A written read on the ranking instead of just a folder of images', '不只是图片文件夹，还要一份对榜单的文字解读'),
          notes: tx('Optional toggle after scraping. Choose the AI source (Follow Settings / Ollama Local / Ollama Cloud / GLM API Cloud) and the report language.', '抓取后的可选项。选择 AI 来源（跟随设置 / Ollama 本地 / Ollama 云端 / GLM API 云端）和报告语言。'),
        },
        {
          name: tx('Occasional blocks are normal', '偶尔被拦是正常现象'),
          bestFor: tx('Interpreting a failed run', '理解一次失败的运行'),
          notes: tx('H&M\'s protection scores each visit, so identical runs can pass and fail minutes apart. Wait a few minutes and retry instead of changing settings right away; immediate retries usually make it worse.', 'H&M 的风控按访问打分，同样的运行几分钟内就可能一过一拦。失败后等几分钟再重试，不要急着改设置；连续立即重试通常只会更糟。'),
        },
      ],
    },
    {
      id: 'organizer',
      title: tx('Image Organizer', '图片整理'),
      summary: tx(
        'Renames garment or fabric photos from label evidence and stores reusable metadata.',
        '根据标签证据重命名服装图或面料图，并保存可复用元数据。',
      ),
      scenarios: [
        tx('You need consistent style or fabric codes before making a PPT.', '你想先把图片整理成统一款号/面料号，再去做 PPT。'),
        tx('You want OCR results and matching metadata to be reused in later modules.', '你希望 OCR 结果和匹配元数据能被后续模块直接复用。'),
      ],
      options: [
        {
          name: tx('Naming: read from label vs group order', '命名：读标签 vs 按组内顺序'),
          bestFor: tx('Label reading gives real style/fabric codes; group order just numbers images 1, 2, 3…', '读标签得到真实款号/面料号；按顺序只是 1, 2, 3 编号'),
          notes: tx('Set how many images make one group and which position is the label. Then choose whether the code is a style number or a fabric code — this decides which OCR fields are prioritized and how Slides Maker reuses the metadata.', '设置几张图为一组、哪一张是标签图，再选择命名按款号还是面料号 —— 这会决定优先读取哪些 OCR 字段，也影响 PPT 生成如何复用元数据。'),
        },
        {
          name: tx('Output mode', '输出方式'),
          bestFor: tx('One folder per group, or everything in a single folder', '一组一个文件夹，或全部放同一文件夹'),
          notes: tx('Grouped folders feed straight into Style mode in Slides Maker.', '分组文件夹可以直接喂给 PPT 生成的款式模式。'),
        },
        {
          name: tx('OCR engine', 'OCR 引擎'),
          bestFor: tx('Guten OCR is the fast default; PaddleOCR-VL 1.6 handles complex labels; DeepSeek OCR is the strongest but slowest', 'Guten OCR 是最快的默认路线；PaddleOCR-VL 1.6 适合复杂标签；DeepSeek OCR 最强但最慢'),
          notes: tx('One engine runs at a time, and engines that are not ready yet stay hidden from the dropdown. A cloud PaddleOCR option is also available.', '同一时间只用一个引擎，未就绪的引擎不会出现在下拉里。另有 PaddleOCR 云端可选。'),
        },
      ],
    },
    {
      id: 'labelocr',
      title: tx('Label OCR', '标签规则'),
      summary: tx(
        'Sets the shared OCR label tags used by Slides Maker and Image Organizer.',
        '统一设置 PPT 生成和图片整理共用的 OCR 标签规则。',
      ),
      scenarios: [
        tx('You want both modules to read the same fields from labels, instead of configuring each one twice.', '你想让两个模块按同一套字段读标签，而不是各配一遍。'),
        tx('The default tag set does not match the labels you shoot.', '默认标签集合和你们拍的标签对不上。'),
      ],
      options: [
        {
          name: tx('Shared tag rules', '共享标签规则'),
          bestFor: tx('Consistent OCR reading across modules', '让各模块的 OCR 读取保持一致'),
          notes: tx('Rules set here apply to both Slides Maker and Image Organizer. Reset to defaults restores the built-in tag set at any time.', '这里设置的规则同时作用于 PPT 生成和图片整理；「恢复默认标签」随时可以还原内置规则。'),
        },
      ],
    },
    {
      id: 'pdf',
      title: tx('PDF Squeezer', 'PDF压缩器'),
      summary: tx(
        'Compresses one or more PDFs and gives you a cleaner save workflow for sending or archiving.',
        '压缩一个或多个 PDF，并提供更适合发送邮件或归档的保存流程。',
      ),
      scenarios: [
        tx('You need a PDF under an email attachment limit such as 10MB.', '你需要把 PDF 压到邮件可发送的体积，比如 10MB 以下。'),
        tx('You want a smaller copy before uploading to chat, cloud drives, or WhatsApp/WeChat.', '你想先把 PDF 缩小，再上传到聊天、网盘或微信。'),
      ],
      options: [
        {
          name: tx('Light', '轻度'),
          bestFor: tx('Minor cleanup when you want to preserve quality', '希望尽量保留质量，只做轻量缩小'),
          notes: tx('Best for already-optimized PDFs or decks with important small text.', '适合本来就不大的 PDF，或里面的小字比较重要的文档。'),
        },
        {
          name: tx('Balanced', '均衡'),
          bestFor: tx('Daily use when you want clear pages and meaningful savings', '日常使用，想兼顾清晰度和压缩率'),
          notes: tx('Usually the best default for reports, lookbooks, and meeting decks.', '通常是报告、lookbook、会议资料最合适的默认档。'),
        },
        {
          name: tx('Strong', '强力'),
          bestFor: tx('Email targets and very large scanned PDFs', '邮件目标体积和特别大的扫描 PDF'),
          notes: tx('More aggressive and may soften images, but it gives the highest chance of reaching a strict file-size target.', '更激进，图片可能更软，但最有机会压到严格的体积目标。'),
        },
      ],
    },
  ];
}

function HelpManual({ onClose }) {
  const { tx } = useI18n();
  const sections = buildManualSections(tx);

  return (
    <div className="help-manual-overlay" onClick={onClose}>
      <section className="help-manual-panel" onClick={(event) => event.stopPropagation()}>
        <header className="help-manual-header">
          <div>
            <span className="help-manual-kicker">{tx('Help', '帮助')}</span>
            <h1>{tx('Module Handbook', '模块使用手册')}</h1>
            <p>
              {tx(
                'Use this page to decide which module to open, which mode to choose, and what tradeoffs to expect.',
                '这个页面用来帮助你判断该打开哪个模块、该选哪种模式，以及每种选项的大致取舍。',
              )}
            </p>
          </div>
          <button type="button" className="help-manual-close" onClick={onClose}>
            {tx('Close', '关闭')}
          </button>
        </header>

        <nav className="help-manual-nav" aria-label={tx('Module quick jump', '模块快速跳转')}>
          {sections.map((section) => (
            <a key={section.id} href={`#help-${section.id}`} className="help-manual-chip">
              {section.title}
            </a>
          ))}
        </nav>

        <div className="help-manual-content">
          {sections.map((section) => (
            <article key={section.id} id={`help-${section.id}`} className="help-manual-card">
              <div className="help-manual-card-top">
                <h2>{section.title}</h2>
                <p>{section.summary}</p>
              </div>

              <div className="help-manual-block">
                <h3>{tx('When to use it', '适用场景')}</h3>
                <ul>
                  {section.scenarios.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>

              <div className="help-manual-block">
                <h3>{tx('Options and traits', '选项特点')}</h3>
                <div className="help-manual-option-grid">
                  {section.options.map((option) => (
                    <div key={option.name} className="help-manual-option-card">
                      <strong>{option.name}</strong>
                      <span>{option.bestFor}</span>
                      <p>{option.notes}</p>
                    </div>
                  ))}
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

export default HelpManual;
