import React from 'react';
import { useI18n } from '../utils/i18n';
import './HelpManual.css';

function buildManualSections(tx) {
  return [
    {
      id: 'slides',
      title: tx('Slides Maker', 'PPT 生成'),
      summary: tx(
        'Turns already-named folders or image groups into presentation-ready decks.',
        '把整理好的文件夹或图片分组直接做成可交付的演示文稿。',
      ),
      scenarios: [
        tx('You already have front/back images or fabric images and need a deck quickly.', '你已经有正反面图或面料图，想快速出一份 PPT。'),
        tx('You want the app to reuse organizer metadata instead of re-reading the same labels.', '你想让软件复用图片整理元数据，而不是重复分析同一批标签。'),
      ],
      options: [
        {
          name: tx('Style images + label image', '款式图 + 标签图'),
          bestFor: tx('Front/back garment presentations with label details', '正反面款式展示并带标签信息'),
          notes: tx('Best when each style has matching garment photos and a clear label image. Reuses organizer JSON when available.', '最适合每个款都有正反面图和清晰标签图的情况；如果已有整理 JSON，会优先复用。'),
        },
        {
          name: tx('Single fabric image with label', '单张面料图带标签'),
          bestFor: tx('Fabric decks with one fabric per page', '一页一个面料的面料类 PPT'),
          notes: tx('Fixed single-page layout. Good when each fabric already has one hero image and one label source.', '固定单页版式，适合每个面料已有主图和标签来源的情况。'),
        },
        {
          name: tx('Moondream2 + Gr3_Fabric', 'Moondream2 + Gr3_Fabric'),
          bestFor: tx('Use for richer apparel-style descriptions in PPT fields', '适合在 PPT 描述字段里生成更专业的服装款式描述'),
          notes: tx('Moondream2 reads garment category, silhouette, and details; Gr3_Fabric complements fabric appearance and finish clues. The two outputs are merged into one cleaner description.', 'Moondream2 负责服装品类、轮廓和细节，Gr3_Fabric 补充面料外观与后整理线索，最后会合并成更完整的描述。'),
        },
        {
          name: tx('Style images only', '仅款式图'),
          bestFor: tx('Fast garment decks when no label data exists yet', '暂时没有标签信息时快速出款式 PPT'),
          notes: tx('Reads files named like STYLE_F and STYLE_B. Optional blank fields can be kept in the slide for manual filling later.', '读取像 `款号_F`、`款号_B` 这样的命名。也可以保留空白字段，方便后续人工填写。'),
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
        tx('You need consistent style codes before making a PPT.', '你想先把图片整理成统一款号，再去做 PPT。'),
        tx('You want OCR results and matching metadata to be reused in later modules.', '你希望 OCR 结果和匹配元数据能被后续模块直接复用。'),
      ],
      options: [
        {
          name: tx('Automatic grouping', '自动分组'),
          bestFor: tx('Mixed folders where the app should infer which image is F/B/label', '文件夹内容较杂，需要软件自动判断 F/B/标签图'),
          notes: tx('More flexible, but depends on OCR and layout clues. Best when image order is not guaranteed.', '更灵活，但更依赖 OCR 和版面线索。适合图片顺序不固定的情况。'),
        },
        {
          name: tx('Fixed grouping', '固定分组'),
          bestFor: tx('Shot lists like 1,2,3 and 4,5,6 where the last image is always the label', '像 1,2,3 / 4,5,6 这种固定拍摄顺序，且最后一张总是标签图'),
          notes: tx('Fastest and most stable when the shooting pattern is consistent.', '拍摄顺序稳定时，这种方式最快也最稳。'),
        },
        {
          name: tx('Style code naming vs fabric code naming', '按款号命名 vs 按面料号命名'),
          bestFor: tx('Choose style naming for garment decks; choose fabric naming for fabric libraries and fabric PPTs.', '做款式类文件夹和款式 PPT 选款号命名；做面料库和面料 PPT 选面料号命名。'),
          notes: tx('The selected naming strategy determines which OCR fields are prioritized and how later PPT modules can reuse the metadata.', '命名策略会决定优先读取哪些 OCR 字段，也会影响后续 PPT 模块如何复用元数据。'),
        },
        {
          name: tx('Local OCR / PaddleOCR-VL 1.5 vs DeepSeek OCR', '本机 OCR / PaddleOCR-VL 1.5 vs DeepSeek OCR'),
          bestFor: tx('Local OCR is the faster default for daily organizing. DeepSeek OCR V2 is stronger but slower, and PaddleOCR-VL 1.5 is better for more complex labels.', '本机 OCR 是更快的默认路线，适合日常整理；DeepSeek OCR V2 更强但更慢；PaddleOCR-VL 1.5 更适合复杂标签。'),
          notes: tx('The app uses one primary OCR engine at a time. OCR models that are not ready yet stay hidden from dropdowns to avoid confusion.', '当前 OCR 只使用一个主引擎。未就绪的 OCR 模型不会显示在下拉列表里，以避免误解。'),
        },
      ],
    },
    {
      id: 'analysis',
      title: tx('Product Analysis', '产品分析'),
      summary: tx(
        'Builds a product report from PDFs, PPTs, or folders by combining text extraction, visual dedupe, OCR, and optional AI analysis.',
        '从 PDF、PPT 或文件夹生成产品分析报告，结合文字提取、视觉去重、OCR 和可选 AI 分析。',
      ),
      scenarios: [
        tx('You need a market-style report with category, materials, fit, design direction, and recommendations.', '你需要一份带品类、面料、版型、设计方向和建议的市场化分析报告。'),
        tx('You are analyzing lookbooks, meeting-note PDFs, or mixed folder drops from buyers and vendors.', '你要分析 lookbook、会议 PDF，或买手/供应商给的一整包文件夹。'),
      ],
      options: [
        {
          name: tx('PDF / PPT / folder source', 'PDF / PPT / 文件夹来源'),
          bestFor: tx('Pick the source closest to the original material. Folder mode is strongest when image naming is already clean.', '尽量选最接近原始材料的来源；如果图片命名已经很干净，文件夹模式通常最稳。'),
          notes: tx('PDF and PPT mode use text extraction plus visual fallback. Folder mode works best when product images and notes are already separated clearly.', 'PDF 和 PPT 模式会结合文本提取与视觉回退；文件夹模式最适合图片和说明已分得比较清楚的情况。'),
        },
        {
          name: tx('AI enabled', '开启 AI'),
          bestFor: tx('Detailed language, style clustering, fit interpretation, and strategic recommendations', '需要更细的语言描述、风格聚类、版型解读和策略建议'),
          notes: tx('Use this when you want a client-facing or management-facing report. Without AI, the output stays more factual and list-like.', '如果你要交付给客户或管理层，建议开启；不开启时报告会更偏事实型和列表型。'),
        },
        {
          name: tx('Moondream2 + Gr3_Fabric', 'Moondream2 + Gr3_Fabric'),
          bestFor: tx('Sharper apparel reading when category, silhouette, and fabric story matter', '当你更在意品类、版型和面料故事时使用'),
          notes: tx('Moondream2 emphasizes garment family, silhouette, and visible construction; Gr3_Fabric adds textile appearance, surface, and finish clues. Their outputs are merged before the final analysis prompt is written.', 'Moondream2 更擅长服装家族、轮廓和可见结构；Gr3_Fabric 会补充织物外观、表面和整理线索，两者会在进入最终分析提示词前先合并。'),
        },
        {
          name: tx('Visual-first counting', '视觉优先计数'),
          bestFor: tx('Lookbooks with repeated pages, contact sheets, or very small garment labels', '存在重复页、拼页或服装图上小吊牌很多的 lookbook'),
          notes: tx('The app tries to ignore tiny attached labels on garments and counts visually distinct styles instead of every repeated page.', '软件会尽量忽略服装图上的小吊牌，并按视觉上不重复的款式来统计，而不是把重复页面都算进去。'),
        },
      ],
    },
    {
      id: 'pdf',
      title: tx('PDF压缩器', 'PDF压缩器'),
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
    {
      id: 'scraper',
      title: tx('Scraper', '抓取器'),
      summary: tx(
        'Collects product assets and structured information from supported retail sites.',
        '从支持的零售网站抓取商品素材和结构化信息。',
      ),
      scenarios: [
        tx('You need to collect reference images or product pages from Zara, Bershka, or Stradivarius.', '你需要从 Zara、Bershka、Stradivarius 收集参考图或产品页。'),
        tx('You want to batch-save images and metadata for later analysis, naming, or deck generation.', '你想批量保存图片和资料，后续再做分析、命名或 PPT。'),
      ],
      options: [
        {
          name: tx('URL / SKU driven capture', 'URL / 款号驱动抓取'),
          bestFor: tx('Use URLs when you already know the exact page. Use SKU when you need the app to find the page first.', '已知页面链接就直接用 URL；只有款号时用 SKU 让软件先找页面。'),
          notes: tx('SKU lookup can be slower but is more scalable when you only have internal product lists.', 'SKU 查找会稍慢，但当你只有内部货号列表时更适合批量处理。'),
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
