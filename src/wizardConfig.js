// ═══════════════════════════════════════════════════════════
// Wizard Configuration — guides the user through each feature's
// parameters in a step-by-step, adaptive layout.
// ═══════════════════════════════════════════════════════════

// Field types supported by the wizard renderer:
//   'dir-picker'     — directory selection
//   'file-picker'    — file selection
//   'save-picker'    — save file dialog
//   'select'         — single-choice dropdown / radio cards
//   'toggle'         — boolean on/off
//   'text'           — free text input
//   'textarea'       — multi-line text
//   'number'         — numeric input
//   'divider'        — visual separator (no input)
//   'group'          — toggle group (multiple switches)

export const WIZARD_CONFIG = {
  // ── PPT 生成 ──────────────────────────────────────────────
  slides: {
    taskId: 'slides',
    logChannel: 'slides',
    runIPC: 'generatePPT',
    cancelIPC: 'cancelTask',
    cancelArg: 'slides',
    adaptive: true,
    steps: [
      {
        title: { en: 'Source Folder', zh: '源文件夹' },
        desc: { en: 'Pick the folder containing your style or fabric images.', zh: '选择包含款式图或面料图的文件夹。' },
        fields: [
          { key: 'sourceFolder', type: 'dir-picker', label: { en: 'Folder', zh: '文件夹' }, required: true },
        ],
      },
      {
        title: { en: 'Deck Type', zh: 'PPT 类型' },
        desc: { en: 'Choose between a style lookbook or a fabric catalog.', zh: '选择款式画册或面料画册。' },
        fields: [
          {
            key: 'sourceMode', type: 'select', label: { en: 'Type', zh: '类型' }, required: true,
            options: [
              { value: 'style-images-only', label: { en: 'Style Deck', zh: '款式画册' }, desc: { en: 'Build a deck from style folders.', zh: '从款式文件夹生成演示文稿。' } },
              { value: 'fabric-images', label: { en: 'Fabric Deck', zh: '面料画册' }, desc: { en: 'Compose a fabric lookbook deck.', zh: '生成面料画册演示文稿。' } },
            ],
          },
        ],
      },
      {
        title: { en: 'Layout', zh: '版式' },
        desc: { en: 'Set how images are arranged on each slide.', zh: '设置每页图片的排列方式。' },
        showWhen: (p) => p.sourceMode === 'style-images-only',
        fields: [
          {
            key: 'sourceOrganization', type: 'select', label: { en: 'Organization', zh: '组织方式' },
            options: [
              { value: 'style-folders', label: { en: 'Style Folders', zh: '按款式文件夹' }, desc: { en: 'Each subfolder = one style.', zh: '每个子文件夹 = 一个款式。' } },
              { value: 'single-folder', label: { en: 'Single Folder', zh: '单文件夹' }, desc: { en: 'All images in one folder.', zh: '所有图片在同一文件夹。' } },
            ],
          },
          {
            key: 'stylePageImageCount', type: 'select', label: { en: 'Images per Slide', zh: '每页图片数' },
            options: [1, 2, 3, 4, 6].map(n => ({ value: n, label: { en: `${n}`, zh: `${n}` } })),
          },
          {
            key: 'imageSuffixes', type: 'text', label: { en: 'Image Suffixes', zh: '图片后缀' },
            hint: { en: 'Comma-separated, e.g. F,B,S,D — determines the display order of images', zh: '逗号分隔，如 F,B,S,D — 决定图片的显示顺序' },
            placeholder: 'F,B,S,D',
          },
        ],
      },
      {
        title: { en: 'Fabric Layout', zh: '面料版式' },
        desc: { en: 'Set how fabric images are arranged.', zh: '设置面料图片的排列方式。' },
        showWhen: (p) => p.sourceMode === 'fabric-images',
        fields: [
          {
            key: 'fabricPageImageCount', type: 'select', label: { en: 'Images per Slide', zh: '每页图片数' },
            options: [{ value: 1, label: { en: '1', zh: '1' } }, { value: 2, label: { en: '2', zh: '2' } }],
          },
        ],
      },
      {
        title: { en: 'Style Fields', zh: '款式字段' },
        desc: { en: 'Choose which style details to display on each slide.', zh: '选择每页要显示的款式信息。' },
        showWhen: (p) => p.sourceMode === 'style-images-only',
        fields: [
          {
            key: 'styleInfoGroup', type: 'group', label: { en: 'Style Information', zh: '款式信息' },
            toggles: [
              { key: 'includeStyleNumber', label: { en: 'Style Number', zh: '款号' }, default: true },
              { key: 'includeName', label: { en: 'Product Name', zh: '产品名称' }, default: true },
              { key: 'includePrice', label: { en: 'Price', zh: '价格' }, default: true },
              { key: 'includeDescription', label: { en: 'Description', zh: '产品描述' }, default: true },
            ],
          },
        ],
      },
      {
        title: { en: 'Fabric Fields', zh: '面料字段' },
        desc: { en: 'Choose which fabric details to display on each slide.', zh: '选择每页要显示的面料信息。' },
        fields: [
          {
            key: 'fabricInfoGroup', type: 'group', label: { en: 'Fabric Information', zh: '面料信息' },
            toggles: [
              { key: 'includeFabricCode', label: { en: 'Fabric Code', zh: '面料代码' } },
              { key: 'includeComposition', label: { en: 'Composition', zh: '成分' } },
              { key: 'includeWidth', label: { en: 'Width', zh: '门幅' } },
              { key: 'includeCuttable', label: { en: 'Cuttable', zh: '可裁门幅' } },
              { key: 'includeWeight', label: { en: 'Weight', zh: '克重' } },
            ],
          },
        ],
      },
      {
        title: { en: 'Presentation', zh: '演示设置' },
        desc: { en: 'Choose theme, structure pages, and export options.', zh: '选择主题、结构页和导出选项。' },
        fields: [
          {
            key: 'pptTheme', type: 'select', label: { en: 'Theme', zh: '主题' }, default: 'classic',
            options: [
              { value: 'classic', label: { en: 'Classic (Black & White)', zh: '经典（黑白）' } },
              { value: 'business', label: { en: 'Business (Navy)', zh: '商务（深蓝）' } },
              { value: 'fashion', label: { en: 'Fashion (Warm Earth)', zh: '时尚（暖色）' } },
              { value: 'modern', label: { en: 'Modern (Minimal Gray)', zh: '现代（极简灰）' } },
            ],
          },
          { key: 'enableToc', type: 'toggle', label: { en: 'Table of Contents', zh: '目录页' }, desc: { en: 'Add a TOC page and category dividers grouped by product category. Grouping uses AI category suggestions when AI is on, otherwise keyword matching.', zh: '添加目录页和按品类分组的分类分隔页。开启 AI 时分组采用 AI 品类建议，否则用关键词匹配。' } },
          { key: 'enableSummary', type: 'toggle', label: { en: 'Summary Page', zh: '汇总页' }, desc: { en: 'AI summary: collection overview, category & composition distribution, and a per-style details table (every style listed, missing fields shown as N/A). Needs AI — ticking it switches AI on automatically.', zh: 'AI 汇总页：系列概述、品类/成分分布和逐款明细表（所有款式都会列出，缺失字段显示 N/A）。需要 AI，勾选本项会自动打开 AI。' } },
          { key: 'exportPdf', type: 'toggle', label: { en: 'Export PDF', zh: '导出 PDF' }, desc: { en: 'Also export a PDF version (requires LibreOffice or PowerPoint).', zh: '同时导出 PDF 版本（需安装 LibreOffice 或 PowerPoint）。' } },
        ],
      },
      {
        title: { en: 'AI & Output', zh: 'AI 与输出' },
        desc: { en: 'Enable AI descriptions and set the output path.', zh: '启用 AI 描述并设置输出路径。' },
        fields: [
          { key: 'ollamaEnabled', type: 'toggle', label: { en: 'AI', zh: 'AI' }, desc: { en: 'AI only fills the checked fields that are still empty (name / description / colour) and shortens descriptions that are too long for the slide. Existing values, composition, fabric code, width and weight are never invented or overwritten. Required by the summary page and AI category suggestions. Pick the endpoint below; models are configured in Settings.', zh: 'AI 只补全「已勾选且仍为空」的字段（名称 / 描述 / 颜色），并精简过长的描述。已有值不会被覆盖，成分、面料代码、门幅、克重绝不臆造。汇总页与 AI 品类建议也依赖本开关。在下方选择 AI 来源，具体模型在设置页配置。' } },
          {
            key: 'llmMode', type: 'select', label: { en: 'AI Model Source', zh: 'AI 模型来源' },
            showWhen: (p) => p.ollamaEnabled,
            default: 'default',
            hint: { en: 'The concrete model comes from the Settings page for the chosen source.', zh: '具体模型取设置页中所选来源已配置的模型。' },
            options: [
              { value: 'default', label: { en: 'Follow Settings', zh: '跟随设置页' } },
              { value: 'local', label: { en: 'Ollama (Local)', zh: 'Ollama 本地' } },
              { value: 'cloud', label: { en: 'Ollama Cloud', zh: 'Ollama 云端' } },
              { value: 'apiCloud', label: { en: 'GLM / API Cloud', zh: 'GLM 云端（API）' } },
            ],
          },
          { key: 'outputPath', type: 'save-picker', label: { en: 'Output File', zh: '输出文件' }, ext: 'pptx', hint: { en: 'Defaults to Desktop', zh: '默认保存到桌面' } },
        ],
      },
    ],
  },

  // ── 抓取器 ──────────────────────────────────────────────
  scraper: {
    taskId: 'scrape',
    logChannel: 'scraper',
    runIPC: 'startTask',
    cancelIPC: 'cancelTask',
    cancelArg: 'scrape',
    adaptive: true,
    steps: [
      {
        title: { en: 'Brand', zh: '品牌' },
        desc: { en: 'Which store to scrape.', zh: '选择要抓取的品牌。' },
        fields: [
          {
            key: 'brand', type: 'select', label: { en: 'Brand', zh: '品牌' }, required: true,
            options: [
              { value: 'zara', label: { en: 'Zara', zh: 'Zara' } },
              { value: 'bershka', label: { en: 'Bershka', zh: 'Bershka' } },
              { value: 'stradivarius', label: { en: 'Stradivarius', zh: 'Stradivarius' } },
              { value: 'pullandbear', label: { en: 'Pull & Bear', zh: 'Pull & Bear' } },
              { value: 'lefties', label: { en: 'Lefties', zh: 'Lefties' } },
              { value: 'mango', label: { en: 'Mango', zh: 'Mango' } },
              { value: 'reserved', label: { en: 'Reserved', zh: 'Reserved' } },
              { value: 'sinsay', label: { en: 'Sinsay', zh: 'Sinsay' } },
              { value: 'urbanrevivo', label: { en: 'Urban Revivo', zh: 'Urban Revivo' } },
              { value: 'newyorker', label: { en: 'New Yorker', zh: 'New Yorker' } },
              { value: 'hm', label: { en: 'H&M', zh: 'H&M' } },
              { value: 'uniqlo', label: { en: 'Uniqlo', zh: 'Uniqlo' } },
              { value: 'gu', label: { en: 'GU', zh: 'GU' } },
              { value: 'abercrombie', label: { en: 'Abercrombie', zh: 'Abercrombie' } },
              { value: 'mixed', label: { en: 'Mixed Brands', zh: '多品牌混合' } },
            ],
          },
        ],
      },
      {
        title: { en: 'Style Numbers', zh: '款号输入' },
        desc: { en: 'Enter style numbers or import from Excel.', zh: '输入款号或从 Excel 导入。' },
        fields: [
          { key: 'styleNumbers', type: 'textarea', label: { en: 'Style Numbers', zh: '款号（逗号分隔）' }, placeholder: '00123, 00456, 00789' },
          { key: 'excelPath', type: 'file-picker', label: { en: 'Or Import from Excel', zh: '或从 Excel 导入' }, ext: ['xlsx', 'xls', 'csv'] },
        ],
      },
      {
        title: { en: 'Output & Options', zh: '输出与选项' },
        desc: { en: 'Set the output folder and download options.', zh: '设置输出目录和下载选项。' },
        fields: [
          { key: 'outputDir', type: 'dir-picker', label: { en: 'Output Folder', zh: '输出目录' }, hint: { en: 'Defaults to Desktop', zh: '默认保存到桌面' } },
          { key: 'downloadConcurrency', type: 'number', label: { en: 'Download Threads', zh: '下载线程数' }, default: 10, min: 1, max: 20 },
          { key: 'zaraBackupMode', type: 'toggle', label: { en: 'Zara Backup Search', zh: 'Zara 备用搜索' }, showWhen: (p) => p.brand === 'zara' },
          { key: 'doAnalyze', type: 'toggle', label: { en: 'AI Trend Analysis', zh: 'AI 趋势分析' }, desc: { en: 'Run AI analysis after scraping. Pick the AI source below; models are configured in Settings.', zh: '抓取后自动运行 AI 分析。在下方选择 AI 来源，具体模型在设置页配置。' } },
          {
            key: 'llmMode', type: 'select', label: { en: 'AI Model Source', zh: 'AI 模型来源' },
            showWhen: (p) => p.doAnalyze,
            default: 'default',
            hint: { en: 'The concrete model comes from the Settings page for the chosen source.', zh: '具体模型取设置页中所选来源已配置的模型。' },
            options: [
              { value: 'default', label: { en: 'Follow Settings', zh: '跟随设置页' } },
              { value: 'local', label: { en: 'Ollama (Local)', zh: 'Ollama 本地' } },
              { value: 'cloud', label: { en: 'Ollama Cloud', zh: 'Ollama 云端' } },
              { value: 'apiCloud', label: { en: 'GLM / API Cloud', zh: 'GLM 云端（API）' } },
            ],
          },
          {
            key: 'language', type: 'select', label: { en: 'Report Language', zh: '报告语言' },
            showWhen: (p) => p.doAnalyze,
            default: 'en',
            options: [
              { value: 'en', label: { en: 'English', zh: '英文' } },
              { value: 'zh', label: { en: '中文', zh: '中文' } },
            ],
          },
        ],
      },
    ],
  },

  // ── 热门款式分析 ──────────────────────────────────────────
  bestseller: {
    taskId: 'bestseller',
    logChannel: 'bestseller',
    runIPC: 'bestsellerScrape',
    cancelIPC: 'cancelTask',
    cancelArg: 'bestseller',
    adaptive: true,
    steps: [
      {
        title: { en: 'Brand', zh: '品牌' },
        desc: { en: 'Choose which brand bestsellers to scrape.', zh: '选择要抓取的品牌畅销榜。' },
        fields: [
          {
            key: 'brand', type: 'select', label: { en: 'Brand', zh: '品牌' }, required: true,
            options: [
              { value: 'newyorker', label: { en: 'New Yorker', zh: 'New Yorker' } },
              { value: 'uniqlo', label: { en: 'UNIQLO (US)', zh: 'UNIQLO（美国站）' } },
              { value: 'hm', label: { en: 'H&M (US)', zh: 'H&M（美国站）' } },
              { value: 'intersport', label: { en: 'Intersport', zh: 'Intersport' } },
            ],
          },
        ],
      },
      {
        title: { en: 'Category', zh: '类别' },
        desc: { en: 'Choose which bestseller listing to scrape.', zh: '选择要抓取的畅销榜类别。' },
        fields: [
          {
            key: 'gender', type: 'select', label: { en: 'Gender', zh: '性别' }, required: true,
            options: [
              { value: 'female', label: { en: "Women's", zh: '女装' } },
              { value: 'male', label: { en: "Men's", zh: '男装' } },
            ],
          },
          {
            key: 'intersportCategory', type: 'select', label: { en: 'Product Category', zh: '产品品类' },
            showWhen: (p) => p.brand === 'intersport',
            options: [
              { value: 'funktionsjacken', label: { en: 'Functional Jackets', zh: '功能夹克' } },
              { value: 'daunenjacken', label: { en: 'Down Jackets', zh: '羽绒服' } },
              { value: 'regenjacken', label: { en: 'Rain Jackets', zh: '雨衣' } },
              { value: 'blousons', label: { en: 'Blousons', zh: '夹克' } },
              { value: 'doppeljacken', label: { en: '3-in-1 Jackets', zh: '三合一夹克' } },
              { value: 'hosen', label: { en: 'Pants', zh: '裤子' } },
              { value: 'shorts', label: { en: 'Shorts', zh: '短裤' } },
              { value: 'tights', label: { en: 'Tights', zh: '紧身裤' } },
              { value: 'wanderhosen', label: { en: 'Hiking Pants', zh: '徒步裤' } },
              { value: 'funktionswasche', label: { en: 'Functional Underwear', zh: '功能内衣' } },
              { value: 't-shirts', label: { en: 'T-Shirts', zh: 'T恤' } },
              { value: 'fan-bekleidung', label: { en: 'Fan Apparel', zh: '球迷服饰' } },
            ],
          },
          {
            key: 'productCount', type: 'select', label: { en: 'Product Count', zh: '下载数量' },
            showWhen: (p) => p.brand === 'intersport' || p.brand === 'uniqlo' || p.brand === 'hm',
            options: [
              { value: 10, label: { en: '10', zh: '10款' } },
              { value: 20, label: { en: '20', zh: '20款' } },
              { value: 30, label: { en: '30', zh: '30款' } },
              { value: 50, label: { en: '50', zh: '50款' } },
              { value: 100, label: { en: '100', zh: '100款' } },
              { value: 0, label: { en: 'All (full ranking)', zh: '全部（完整榜单）' } },
            ],
          },
        ],
      },
      {
        title: { en: 'Images', zh: '图片设置' },
        desc: { en: 'How many images per style.', zh: '每个款式抓取多少张图片。' },
        fields: [
          {
            key: 'imagesPerStyle', type: 'select', label: { en: 'Images per Style', zh: '每款图片数' },
            options: [
              { value: 0, label: { en: 'All', zh: '全部' } },
              ...[1, 2, 3, 4, 5, 6].map(n => ({ value: n, label: { en: `${n}`, zh: `${n}` } })),
            ],
          },
          { key: 'allColors', type: 'toggle', label: { en: 'All Colors', zh: '全部颜色' } },
          { key: 'includeAccessories', type: 'toggle', label: { en: 'Include Accessories', zh: '包含配饰' } },
        ],
      },
      {
        title: { en: 'Output & Analysis', zh: '输出与分析' },
        desc: { en: 'Set output folder and AI analysis options.', zh: '设置输出目录和 AI 分析选项。' },
        fields: [
          { key: 'outputDir', type: 'dir-picker', label: { en: 'Output Folder', zh: '输出目录' }, hint: { en: 'Defaults to Desktop', zh: '默认保存到桌面' } },
          { key: 'doAnalyze', type: 'toggle', label: { en: 'AI Trend Report', zh: 'AI 趋势报告' }, default: true, desc: { en: 'Generate an AI trend report after scraping. Pick the AI source below; models are configured in Settings.', zh: '抓取后生成 AI 趋势报告。在下方选择 AI 来源，具体模型在设置页配置。' } },
          {
            key: 'llmMode', type: 'select', label: { en: 'AI Model Source', zh: 'AI 模型来源' },
            showWhen: (p) => p.doAnalyze,
            default: 'default',
            hint: { en: 'The concrete model comes from the Settings page for the chosen source.', zh: '具体模型取设置页中所选来源已配置的模型。' },
            options: [
              { value: 'default', label: { en: 'Follow Settings', zh: '跟随设置页' } },
              { value: 'local', label: { en: 'Ollama (Local)', zh: 'Ollama 本地' } },
              { value: 'cloud', label: { en: 'Ollama Cloud', zh: 'Ollama 云端' } },
              { value: 'apiCloud', label: { en: 'GLM / API Cloud', zh: 'GLM 云端（API）' } },
            ],
          },
          {
            key: 'language', type: 'select', label: { en: 'Report Language', zh: '报告语言' },
            showWhen: (p) => p.doAnalyze,
            default: 'en',
            options: [
              { value: 'en', label: { en: 'English', zh: '英文' } },
              { value: 'zh', label: { en: '中文', zh: '中文' } },
            ],
          },
        ],
      },
    ],
  },

  // ── 图片整理 ──────────────────────────────────────────────
  organizer: {
    taskId: 'slides',
    logChannel: 'slides',
    runIPC: 'organizeStyleImages',
    cancelIPC: 'cancelTask',
    cancelArg: 'slides',
    adaptive: true,
    steps: [
      {
        title: { en: 'Source Folder', zh: '源文件夹' },
        desc: { en: 'Pick the folder with images to rename.', zh: '选择需要整理的图片文件夹。' },
        fields: [
          { key: 'sourceFolder', type: 'dir-picker', label: { en: 'Folder', zh: '文件夹' }, required: true },
        ],
      },
      {
        title: { en: 'Naming Mode', zh: '命名方式' },
        desc: { en: 'Rename by label tags or sequential numbers.', zh: '按标签或数字编号重命名。' },
        fields: [
          {
            key: 'namingMode', type: 'select', label: { en: 'Mode', zh: '方式' }, required: true,
            options: [
              { value: 'label', label: { en: 'By Label', zh: '按标签' }, desc: { en: 'Rename using OCR fabric/style tags.', zh: '使用 OCR 标签重命名。' } },
              { value: 'number', label: { en: 'By Number', zh: '按数字' }, desc: { en: 'Sequential numeric renaming.', zh: '按顺序数字重命名。' } },
            ],
          },
          {
            key: 'labelNamingTarget', type: 'select', label: { en: 'Label Type', zh: '标签类型' },
            showWhen: (p) => p.namingMode === 'label',
            options: [
              { value: 'fabric', label: { en: 'Fabric Label', zh: '面料标签' } },
              { value: 'style', label: { en: 'Style Label', zh: '款式标签' } },
            ],
          },
          {
            key: 'ocrEngine.engine', type: 'select', label: { en: 'OCR Engine', zh: 'OCR 引擎' },
            showWhen: (p) => p.namingMode === 'label',
            default: 'guten-ocr',
            options: [
              { value: '', label: { en: '— Loading available engines... —', zh: '— 加载可用引擎中... —' } },
            ],
          },
          {
            key: 'styleNameField', type: 'select', label: { en: 'Name By', zh: '命名依据' },
            showWhen: (p) => p.namingMode === 'label' && p.labelNamingTarget === 'style',
            options: [
              { value: 'styleNumber', label: { en: 'Style Number', zh: '款号' } },
              { value: 'fabricCode', label: { en: 'Fabric Code', zh: '面料代码' } },
              { value: 'composition', label: { en: 'Composition', zh: '成分' } },
              { value: 'width', label: { en: 'Width', zh: '门幅' } },
              { value: 'cuttable', label: { en: 'Cuttable', zh: '可裁幅' } },
              { value: 'weight', label: { en: 'Weight', zh: '克重' } },
            ],
          },
          {
            key: 'numberStart', type: 'number', label: { en: 'Start Number', zh: '起始编号' },
            showWhen: (p) => p.namingMode === 'number',
            default: 1, min: 1,
          },
          {
            key: 'groupSize', type: 'number', label: { en: 'Images per Group', zh: '每组图片数' },
            showWhen: (p) => p.namingMode === 'number',
            hint: { en: 'How many images share the same number with different suffixes', zh: '多少张图共享同一个编号，用不同后缀区分' },
            default: 4, min: 1,
          },
          {
            key: 'imageSuffixes', type: 'text', label: { en: 'Image Suffixes', zh: '图片后缀' },
            showWhen: (p) => p.namingMode === 'number',
            hint: { en: 'Comma-separated, e.g. F,B,S,D — one suffix per image in each group', zh: '逗号分隔，如 F,B,S,D — 每组中每张图对应一个后缀' },
            placeholder: 'F,B,S,D',
          },
        ],
      },
      {
        title: { en: 'Style Settings', zh: '款式设置' },
        desc: { en: 'Group images and set label position.', zh: '设置图片分组和标签位置。' },
        showWhen: (p) => p.namingMode === 'label' && p.labelNamingTarget === 'style',
        fields: [
          { key: 'groupSize', type: 'number', label: { en: 'Images per Group', zh: '每组图片数' }, default: 4, min: 1 },
          {
            key: 'imageSuffixes', type: 'text', label: { en: 'Image Suffixes', zh: '图片后缀' },
            hint: { en: 'Comma-separated, e.g. F,B,S — for non-label images', zh: '逗号分隔，如 F,B,S — 用于非标签图' },
            placeholder: 'F,B,S',
          },
          {
            key: 'labelIndex', type: 'number', label: { en: 'Label Image Position', zh: '标签图位置' },
            hint: { en: 'Which image in each group has the label (1-based). That image gets no suffix.', zh: '每组中第几张图是标签图（从1开始）。该图不加后缀。' },
            default: 4, min: 1,
          },
        ],
      },
    ],
  },

  // ── 标签规则 ──────────────────────────────────────────────
  labelocr: {
    taskId: null,
    logChannel: null,
    runIPC: null,
    adaptive: false,
    customRender: 'labelocr',
    steps: [],
  },

  // ── PDF 压缩 ──────────────────────────────────────────────
  pdfsqueezer: {
    taskId: 'pdf-squeezer',
    logChannel: 'pdfSqueezer',
    runIPC: 'squeezePDFs',
    cancelIPC: 'cancelTask',
    cancelArg: 'pdf-squeezer',
    adaptive: false,
    steps: [
      {
        title: { en: 'Setup', zh: '配置' },
        desc: { en: 'Pick PDF files and compression level.', zh: '选择 PDF 文件和压缩强度。' },
        fields: [
          { key: 'sourceFiles', type: 'file-picker', label: { en: 'PDF Files', zh: 'PDF 文件' }, ext: ['pdf'], multiple: true, required: true },
          {
            key: 'preset', type: 'select', label: { en: 'Compression', zh: '压缩强度' },
            options: [
              { value: 'balanced', label: { en: 'Balanced', zh: '均衡' }, desc: { en: 'Balanced quality and size.', zh: '均衡质量与体积。' } },
              { value: 'light', label: { en: 'Light', zh: '轻度' }, desc: { en: 'Minimal quality loss.', zh: '最小质量损失。' } },
              { value: 'strong', label: { en: 'Strong', zh: '强力' }, desc: { en: 'Maximum size reduction.', zh: '最大体积压缩。' } },
            ],
          },
        ],
      },
    ],
  },
};
