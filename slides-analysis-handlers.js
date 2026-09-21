const { spawn } = require('child_process');
const { getDefaultOcrEngine, getDefaultOcrFallbackEngine } = require('./ocr-engine-config');
const { modelSupportsVision, pickDefaultModel } = require('./llm-client');

function normalizePathSafeText(value = '') {
  return String(value || '')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSuffix(value = '') {
  return String(value || '')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/^_+/g, '')
    .replace(/\s+/g, '');
}

function buildOrganizedFileName(baseName = '', suffix = '', ext = '') {
  const safeBase = normalizePathSafeText(baseName) || 'Unnamed';
  const safeSuffix = normalizeSuffix(suffix);
  return safeSuffix ? `${safeBase}_${safeSuffix}${ext}` : `${safeBase}${ext}`;
}

function normalizeStyleNameField(summary = {}) {
  const value = String(summary.styleNameField || 'styleNumber').trim();
  return [
    'fabricCode',
    'styleNumber',
    'description',
    'composition',
    'width',
    'cuttable',
    'weight',
  ].includes(value) ? value : 'styleNumber';
}

function formatFallbackStyleName(index = 1) {
  return `style number_${String(Math.max(1, Number(index) || 1)).padStart(2, '0')}`;
}

function resolveReviewedBaseName(style = {}, summary = {}) {
  const labelInfo = style?.labelInfo || {};
  const labelNamingTarget = summary?.labelNamingTarget === 'fabric' ? 'fabric' : 'style';
  const styleNameField = normalizeStyleNameField(summary);
  const rawValue = labelNamingTarget === 'fabric'
    ? (labelInfo.fabricCode || labelInfo.styleNumber || style.styleNumber || style.folderName || '')
    : (labelInfo[styleNameField] || '');
  const normalized = normalizePathSafeText(rawValue);
  if (labelNamingTarget === 'style' && styleNameField === 'description' && !normalized) {
    return formatFallbackStyleName(style.__reviewIndex + 1);
  }
  return normalized || 'Unnamed';
}

function resolveReviewedFolderPlan(styles = [], summary = {}) {
  const seen = new Map();
  return styles.map((style, index) => {
    const baseName = resolveReviewedBaseName({ ...style, __reviewIndex: index }, summary);
    const currentCount = seen.get(baseName) || 0;
    seen.set(baseName, currentCount + 1);
    const duplicateIndex = currentCount === 0 ? 0 : currentCount + 1;
    const folderName = duplicateIndex > 0 ? `${baseName}__${duplicateIndex}` : baseName;
    return {
      ...style,
      appliedName: baseName,
      folderName,
      duplicateIndex,
    };
  });
}

function resolveFileSuffix(fileKey = '', summary = {}) {
  if (fileKey === 'label') {
    return summary?.labelSuffix || '';
  }
  const match = /^image(\d+)$/i.exec(String(fileKey || ''));
  if (!match) {
    return '';
  }
  const index = Math.max(0, Number(match[1]) - 1);
  return Array.isArray(summary?.imageSuffixes) ? (summary.imageSuffixes[index] || '') : '';
}

function renameWithTemp(fs, path, operations = []) {
  const actionable = operations
    .filter((operation) => operation?.from && operation?.to)
    .map((operation) => ({
      from: path.resolve(String(operation.from)),
      to: path.resolve(String(operation.to)),
    }))
    .filter((operation) => operation.from !== operation.to && fs.existsSync(operation.from));

  if (actionable.length === 0) {
    return;
  }

  const duplicateTargets = actionable
    .map((operation) => operation.to)
    .filter((targetPath, index, list) => list.indexOf(targetPath) !== index);
  if (duplicateTargets.length > 0) {
    throw new Error(`Duplicate rename target detected: ${duplicateTargets[0]}`);
  }

  const staged = actionable.map((operation, index) => ({
    ...operation,
    temp: path.join(
      path.dirname(operation.from),
      `.__gsbot_review_tmp_${Date.now()}_${index}_${path.basename(operation.from)}`,
    ),
  }));

  staged.forEach((operation) => {
    fs.mkdirSync(path.dirname(operation.temp), { recursive: true });
    fs.renameSync(operation.from, operation.temp);
  });

  try {
    staged.forEach((operation) => {
      fs.mkdirSync(path.dirname(operation.to), { recursive: true });
      if (fs.existsSync(operation.to)) {
        throw new Error(`Target already exists: ${operation.to}`);
      }
      fs.renameSync(operation.temp, operation.to);
    });
  } catch (error) {
    staged.forEach((operation) => {
      if (fs.existsSync(operation.temp) && !fs.existsSync(operation.from)) {
        fs.renameSync(operation.temp, operation.from);
      }
    });
    throw error;
  }
}

function applyOrganizeReviewResults(fs, path, payload = {}) {
  const summaryPath = path.resolve(String(payload.summaryPath || '').trim());
  if (!summaryPath || !fs.existsSync(summaryPath)) {
    throw new Error('Review summary was not found.');
  }

  const parsed = JSON.parse(fs.readFileSync(summaryPath, 'utf8') || '{}');
  const styles = Array.isArray(parsed.styles) ? parsed.styles : [];
  if (styles.length === 0) {
    return { success: true, summaryPath, updatedCount: 0, styles: [] };
  }

  const nextStyles = resolveReviewedFolderPlan(styles, parsed);
  const outputFolder = path.resolve(String(parsed.outputFolder || '').trim());
  const outputMode = parsed.outputMode === 'single-folder' ? 'single-folder' : 'style-folders';
  const metadataDir = path.join(outputFolder, '_organize_meta');

  if (outputMode === 'style-folders') {
    renameWithTemp(fs, path, nextStyles.map((style, index) => ({
      from: styles[index]?.folder,
      to: path.join(outputFolder, style.folderName),
    })));
  }

  const appliedStyles = nextStyles.map((style, index) => {
    const previousStyle = styles[index] || {};
    const folderPath = outputMode === 'single-folder'
      ? outputFolder
      : path.join(outputFolder, style.folderName);
    const currentFiles = previousStyle.files || {};
    const nextFiles = {};

    renameWithTemp(fs, path, Object.entries(currentFiles).map(([fileKey, currentPath]) => {
      const currentResolvedPath = outputMode === 'single-folder'
        ? currentPath
        : path.join(folderPath, path.basename(String(currentPath || '')));
      const ext = path.extname(String(currentResolvedPath || '')) || path.extname(String(currentPath || '')) || '.jpg';
      const targetName = buildOrganizedFileName(style.appliedName || style.styleNumber, resolveFileSuffix(fileKey, parsed), ext);
      const nextPath = path.join(folderPath, targetName);
      nextFiles[fileKey] = nextPath;
      return {
        from: currentResolvedPath,
        to: nextPath,
      };
    }));

    const nextInfo = {
      ...previousStyle,
      ...style,
      folder: folderPath,
      files: nextFiles,
      galleryImagePaths: Object.entries(nextFiles)
        .filter(([fileKey]) => fileKey !== 'label')
        .map(([, filePath]) => filePath),
    };
    nextInfo.infoPath = path.join(metadataDir, `${style.folderName}_organize_info.json`);
    return nextInfo;
  });

  renameWithTemp(fs, path, styles.map((style, index) => ({
    from: style.infoPath,
    to: appliedStyles[index]?.infoPath,
  })));

  appliedStyles.forEach((style) => {
    fs.writeFileSync(style.infoPath, JSON.stringify(style, null, 2), 'utf8');
  });

  const nextSummary = {
    ...parsed,
    styles: appliedStyles,
    reviewedAt: new Date().toISOString(),
    reviewAppliedAt: new Date().toISOString(),
  };
  fs.writeFileSync(summaryPath, JSON.stringify(nextSummary, null, 2), 'utf8');

  return {
    success: true,
    summaryPath,
    outputFolder,
    updatedCount: appliedStyles.length,
    styles: appliedStyles,
  };
}

function registerSlidesAnalysisHandlers({
  ipcMain,
  dialog,
  app,
  fs,
  path,
  runtimeResolver,
  getPythonRuntime,
  runManagedTask,
  updateTaskSnapshot,
  activeTaskControllers,
  assertLicensedForFeature,
  getLicenseFailurePayload,
  listVisionCandidates,
  promptVisionDecision,
}) {
  ipcMain.handle('read-dir', async (_event, dirPath) => {
    try {
      const items = fs.readdirSync(dirPath, { withFileTypes: true });
      return {
        success: true,
        items: items.map((item) => ({
          name: item.name,
          isDirectory: item.isDirectory(),
          isFile: item.isFile(),
        })),
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('read-file', async (_event, filePath) => {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return { success: true, content };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('save-organize-info', async (_event, payload = {}) => {
    try {
      const targetPath = String(payload.filePath || '').trim();
      const content = payload.content;
      if (!targetPath) {
        return { success: false, error: 'Missing file path.' };
      }
      fs.writeFileSync(targetPath, JSON.stringify(content, null, 2), 'utf8');
      return { success: true, filePath: targetPath };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('apply-organize-review-results', async (_event, payload = {}) => {
    try {
      return applyOrganizeReviewResults(fs, path, payload);
    } catch (error) {
      return {
        success: false,
        error: error.message || String(error),
      };
    }
  });

  ipcMain.handle('export-organize-excel', async (_event, payload = {}) => {
    try {
      const organizer = require('./style-organizer');
      return await organizer.exportOrganizeSummaryToExcel(payload);
    } catch (error) {
      return {
        success: false,
        error: error.message || String(error),
      };
    }
  });

  ipcMain.handle('save-file-dialog', async (_event, options) => {
    try {
      const result = await dialog.showSaveDialog({
        defaultPath: options.defaultPath || 'output.pptx',
        filters: options.filters || [{ name: 'PowerPoint', extensions: ['pptx'] }],
      });
      return result.canceled ? null : result.filePath;
    } catch (_error) {
      return null;
    }
  });

  ipcMain.handle('get-image-base64', async (_event, imagePath) => {
    try {
      const imageBuffer = fs.readFileSync(imagePath);
      const base64 = imageBuffer.toString('base64');
      const ext = path.extname(imagePath).toLowerCase();
      let mimeType = 'image/jpeg';
      if (ext === '.png') mimeType = 'image/png';
      else if (ext === '.webp') mimeType = 'image/webp';

      return {
        success: true,
        data: `data:${mimeType};base64,${base64}`,
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('generate-ppt', async (event, config) => {
    try {
      assertLicensedForFeature();
    } catch (error) {
      const licenseFailure = getLicenseFailurePayload(error);
      if (licenseFailure) {
        return licenseFailure;
      }
      throw error;
    }

    return runManagedTask(event, 'slides', async (taskController) => new Promise((resolve) => {
      const { buildSlidesPrecomputedInfo } = require('./slides-preprocessor');
      const pythonRuntime = getPythonRuntime();
      const slidesSettings = config?.config || {};
      const sourceMode = slidesSettings.sourceMode || 'style-images-only';

      updateTaskSnapshot(event.sender, 'slides', {
        inputPath: String(config?.sourceFolder || '').trim(),
        outputPath: String(config?.outputPath || '').trim(),
        summary: sourceMode === 'fabric-images'
          ? 'PPT generation · fabric mode'
          : sourceMode === 'label-images'
            ? 'PPT generation · label mode'
            : 'PPT generation · style-only mode',
        cacheMode: slidesSettings.forceRefresh ? 'force-refresh' : 'use-cache',
      });

      if (!pythonRuntime) {
        resolve({
          success: false,
          error: 'Python 3 was not found. Please install Python 3, python-pptx, and Pillow before using Slides Maker.',
        });
        return;
      }

      const scriptPath = app.isPackaged
        ? path.join(process.resourcesPath, 'app.asar.unpacked', 'generate_slides.py')
        : path.join(__dirname, 'generate_slides.py');

      console.log('Script path:', scriptPath);
      console.log('Script exists:', fs.existsSync(scriptPath));

      const pythonEnv = {
        ...runtimeResolver.getPythonSpawnEnv(pythonRuntime),
        PYTHONUNBUFFERED: '1',
        PYTHONIOENCODING: 'utf-8',
      };

      let pythonProcess = null;
      let outputData = '';
      let errorData = '';
      let precomputedIssues = null;

      taskController.onCancel(() => {
        event.sender.send('slides-log', {
          time: new Date().toLocaleTimeString(),
          message: 'Cancellation requested. Stopping the generator...',
          type: 'warning',
        });

        if (pythonProcess && !pythonProcess.killed) {
          pythonProcess.kill('SIGTERM');
          setTimeout(() => {
            if (pythonProcess && !pythonProcess.killed) {
              pythonProcess.kill('SIGKILL');
            }
          }, 1500);
        }
      });

      (async () => {
        try {
          // Vision pre-flight. Every AI path below hands images to the model
          // (style photos, label images, fabric swatches) and a text-only model
          // comes back with prose about images it never received — Python only
          // notices after the fact via VISION_UNSUPPORTED_TARGETS. Ask first.
          const llmSettings = slidesSettings.llmConfig || {};
          const configuredVision = slidesSettings.apparelVision || {};
          // The wizard only carries an "AI on/off" switch; the model comes from
          // the settings page. If the saved model is empty, resolve one from the
          // endpoint itself (highest flash version on clouds, first installed
          // model locally) so Python never sees an empty model name.
          let mainModel = String(llmSettings.model || '').trim();
          if (!mainModel && (slidesSettings.ollamaEnabled || slidesSettings.enableSummary)) {
            try {
              const LLMClient = require('./llm-client');
              const probe = new LLMClient({
                baseUrl: llmSettings.baseUrl || 'http://localhost:11434',
                model: '',
                apiKey: llmSettings.apiKey || '',
                provider: llmSettings.provider || 'auto',
                timeout: 15000,
              });
              const test = await probe.testConnection();
              const picked = pickDefaultModel(llmSettings.mode, test?.models || []);
              if (picked) {
                // Mutate in place: this object is spread into the Python stdin
                // payload later, so the resolved model must land here.
                slidesSettings.llmConfig.model = picked;
                mainModel = picked;
                event.sender.send('slides-log', {
                  time: new Date().toLocaleTimeString(),
                  message: `No model configured — using ${picked} from ${llmSettings.mode === 'apiCloud' ? 'API cloud' : llmSettings.mode === 'cloud' ? 'cloud' : 'local'} endpoint.`,
                  type: 'info',
                });
              }
            } catch {
              // Endpoint unreachable: leave the model empty and let the run
              // fail with the endpoint's own error message.
            }
          }
          // Mirrors Python's resolve_apparel_vision_settings(): an empty slot
          // falls back to the main model. Only the models that actually receive
          // images are checked, so a deliberate "text-only main model + separate
          // vision model" setup is not flagged.
          const resolveVisionSlot = (value) => String(value || '').trim() || mainModel;
          const visionInPlay = Array.from(new Set([
            resolveVisionSlot(configuredVision.garmentModel),
            resolveVisionSlot(configuredVision.fabricModel),
          ].filter(Boolean)));
          // Probe each model's real capability from the endpoint (Ollama
          // /api/show) before falling back to the name heuristic — several
          // modern families read images without a vision-ish name.
          const llmClientModule = require('./llm-client');
          const probedMap = await llmClientModule.probeVisionForModels(
            llmSettings.baseUrl,
            llmSettings.apiKey,
            visionInPlay
          ).catch(() => new Map());
          const isVisionModel = (m) => {
            const real = probedMap.get(m);
            if (real === true) return true;
            if (real === false) return false;
            return modelSupportsVision(m);
          };
          const nonVisionModels = visionInPlay.filter((m) => !isVisionModel(m));
          if (nonVisionModels.length) {
            const candidates = await listVisionCandidates(llmSettings);
            const decision = await promptVisionDecision({
              sender: event.sender,
              model: nonVisionModels[0],
              candidates,
              cn: /^zh/i.test(String(app.getLocale() || '')),
              log: (message, type = 'info') => event.sender.send('slides-log', {
                time: new Date().toLocaleTimeString(),
                message,
                type,
              }),
            });
            if (decision.action === 'cancel') {
              resolve({
                success: false,
                cancelled: true,
                error: 'Presentation generation cancelled: the selected model cannot read images.',
              });
              return;
            }
            if (decision.action === 'switch' && decision.model) {
              // Mutate in place: this very object is spread into a new config
              // later (plainly, right before Python is spawned), so replacing it
              // here would silently drop the user's choice.
              slidesSettings.apparelVision = {
                ...configuredVision,
                enabled: true,
                garmentModel: decision.model,
                fabricModel: decision.model,
              };
              event.sender.send('slides-log', {
                time: new Date().toLocaleTimeString(),
                message: `Switched vision model to ${decision.model}`,
                type: 'success',
              });
            }
          }

          if (slidesSettings.sourceMode === 'label-images' || slidesSettings.sourceMode === 'fabric-images' || slidesSettings.sourceMode === 'style-images-only') {
            event.sender.send('slides-log', {
              time: new Date().toLocaleTimeString(),
              message: slidesSettings.sourceMode === 'fabric-images'
                ? 'Preparing local OCR for fabric label images...'
                : slidesSettings.sourceMode === 'style-images-only'
                  ? 'Preparing style-only slide data...'
                  : 'Preparing local OCR for label images...',
              type: 'info',
            });
            event.sender.send('slides-progress', 18);

            const precomputedInfo = await buildSlidesPrecomputedInfo(
              config.sourceFolder,
              slidesSettings,
              (message, type = 'info') => event.sender.send('slides-log', {
                time: new Date().toLocaleTimeString(),
                message,
                type,
              }),
              (stageMeta) => {
                const stageProgress = typeof stageMeta?.progress === 'number' ? stageMeta.progress : 0;
                const normalized = 18 + Math.round(Math.min(1, Math.max(0, stageProgress)) * 10);
                event.sender.send('slides-progress', normalized);
              },
            );
            config.config = {
              ...slidesSettings,
              precomputedInfo,
            };
            precomputedIssues = precomputedInfo?.__issues || null;
            updateTaskSnapshot(event.sender, 'slides', {
              summary: `${slidesSettings.sourceMode === 'fabric-images' ? 'PPT generation · fabric mode' : slidesSettings.sourceMode === 'style-images-only' ? 'PPT generation · style-only mode' : 'PPT generation · label mode'} · ${precomputedInfo?.__meta?.cacheHit ? 'cache hit' : 'fresh OCR'}`,
            });
            event.sender.send('slides-log', {
              time: new Date().toLocaleTimeString(),
              message: `${precomputedInfo?.__meta?.cacheHit ? 'Reused' : 'Prepared'} ${Object.keys(precomputedInfo).filter((key) => !key.startsWith('__')).length} ${slidesSettings.sourceMode === 'fabric-images' ? 'fabric items' : 'style folders'} for ${slidesSettings.sourceMode === 'fabric-images' ? 'fabric mode' : slidesSettings.sourceMode === 'style-images-only' ? 'style-only mode' : 'label mode'}.`,
              type: 'success',
            });
            event.sender.send('slides-progress', 28);
          }

          pythonProcess = spawn(
            pythonRuntime.command,
            [...pythonRuntime.args, scriptPath],
            {
              windowsHide: true,
              env: pythonEnv,
            },
          );

          pythonProcess.stdin.setDefaultEncoding('utf8');
          pythonProcess.stdin.write(JSON.stringify(config), 'utf8');
          pythonProcess.stdin.end();

          pythonProcess.stdout.on('data', (data) => {
            const output = data.toString();
            outputData += output;
            console.log('Python output:', output);

            output.split('\n').forEach((line) => {
              if (line.trim()) {
                event.sender.send('slides-log', {
                  time: new Date().toLocaleTimeString(),
                  message: line.trim(),
                  type: 'info',
                });
              }
            });
          });

          pythonProcess.stderr.on('data', (data) => {
            const output = data.toString();
            errorData += output;
            console.error('Python error:', output);
            output.split('\n').forEach((line) => {
              if (line.trim()) {
                event.sender.send('slides-log', {
                  time: new Date().toLocaleTimeString(),
                  message: `[stderr] ${line.trim()}`,
                  type: 'warning',
                });
              }
            });
          });

          pythonProcess.on('close', (code) => {
            if (taskController.cancelled) {
              resolve({
                success: false,
                cancelled: true,
                error: 'Presentation generation cancelled by user.',
              });
              return;
            }

            if (code === 0) {
              try {
                const lines = outputData.trim().split('\n');
                const lastLine = lines[lines.length - 1];
                const result = JSON.parse(lastLine);
                resolve({
                  ...result,
                  issues: precomputedIssues || result?.issues || null,
                });
              } catch (_error) {
                resolve({
                  success: true,
                  outputPath: config.outputPath,
                  issues: precomputedIssues,
                });
              }
            } else {
              resolve({
                success: false,
                error: errorData || `Python脚本退出码: ${code}`,
              });
            }
          });

          pythonProcess.on('error', (error) => {
            resolve({
              success: false,
              error: `Failed to start Python: ${error.message}. Please install Python 3, python-pptx, and Pillow.`,
            });
          });
        } catch (error) {
          resolve({
            success: false,
            error: error.message || String(error),
          });
        }
      })();
    }), activeTaskControllers);
  });

  ipcMain.handle('organize-style-images', async (event, payload) => {
    try {
      assertLicensedForFeature();
    } catch (error) {
      const licenseFailure = getLicenseFailurePayload(error);
      if (licenseFailure) {
        return licenseFailure;
      }
      throw error;
    }

    return runManagedTask(event, 'slides', async (taskController) => {
      const organizer = require('./style-organizer');
      const outputFolder = String(payload?.outputFolder || '').trim();
      const organizeConfig = payload?.config || {};
      updateTaskSnapshot(event.sender, 'slides', {
        inputPath: String(payload?.sourceFolder || '').trim(),
        outputPath: outputFolder,
        summary: `Image organize · ${organizeConfig?.labelNamingTarget === 'fabric' ? 'fabric labels' : 'style labels'}`,
        cacheMode: organizeConfig?.forceRefresh ? 'force-refresh' : 'use-cache',
      });
      const emitLog = (message, type = 'info') => {
        event.sender.send('slides-log', {
          time: new Date().toLocaleTimeString(),
          message,
          type,
        });
      };
      const emitProgress = (value) => {
        if (value && typeof value === 'object' && value.preview) {
          event.sender.send('slides-progress-preview', value.preview);
          if (typeof value.progress === 'number') {
            event.sender.send('slides-progress', value.progress);
          }
          return;
        }
        event.sender.send('slides-progress', value);
      };

      emitLog('Preparing image organizer...', 'info');
      emitProgress(6);

      return organizer.organizeStyleImages(
        payload,
        emitLog,
        emitProgress,
        {
          ensureActive: () => taskController.throwIfCancelled(),
        },
      );
    }, activeTaskControllers);
  });

  ipcMain.handle('analyze-products', async (event, config) => {
    try {
      assertLicensedForFeature();
      console.log('[ANALYZE] Starting analysis with config:', JSON.stringify(config, null, 2));
      const reportGenerator = require('./report-generator');

      const emitLog = (msg, type = 'info') => {
        console.log('[ANALYZE LOG]', msg);
        event.sender.send('analysis-log', {
          time: new Date().toLocaleTimeString(),
          message: msg,
          type,
        });
      };
      const emitProgress = (val) => {
        event.sender.send('analysis-progress', val);
      };

      return await runManagedTask(event, 'analysis', async (taskController) => {
        emitLog('Preparing analysis pipeline...', 'info');
        emitProgress(15);
        taskController.throwIfCancelled();

        const outputPath = config.outputPath
          || (fs.statSync(config.sourcePath).isDirectory()
            ? path.join(config.sourcePath, 'Product_Analysis_Report.docx')
            : config.sourcePath.replace(/\.[^.]+$/, '_Analysis_Report.docx'));
        updateTaskSnapshot(event.sender, 'analysis', {
          inputPath: String(config?.sourcePath || '').trim(),
          outputPath: String(outputPath || '').trim(),
          summary: `Product analysis · ${config?.template || 'auto'} template`,
          cacheMode: 'live-run',
        });

        console.log('[ANALYZE] Calling generateReportFromSource...');
        const result = await reportGenerator.generateReportFromSource(config.sourcePath, outputPath, {
          title: config.title || 'Product Collection Analysis Report',
          template: config.template || 'auto',
          collectionLabel: config.collectionLabel || '',
          enableVision: config.enableVision || false,
          ocrEngine: config.ocrEngine || getDefaultOcrEngine(),
          ocrFallbackEngine: config.ocrFallbackEngine ?? getDefaultOcrFallbackEngine(),
          apparelVision: config.apparelVision || null,
          llm: config.llm || { enabled: false },
          emitLog,
          emitProgress,
          ensureActive: () => taskController.throwIfCancelled(),
        });

        console.log('[ANALYZE] Result:', JSON.stringify(result, null, 2));
        emitProgress(100);
        emitLog('Report generated successfully', 'success');

        return result;
      }, activeTaskControllers);
    } catch (error) {
      const licenseFailure = getLicenseFailurePayload(error);
      if (licenseFailure) {
        return licenseFailure;
      }
      console.error('[ANALYZE ERROR]', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('test-llm-connection', async (_event, config) => {
    try {
      const LLMClient = require('./llm-client');
      const client = new LLMClient({
        baseUrl: config.baseUrl || 'http://localhost:11434',
        model: config.model || '',
        apiKey: config.apiKey || '',
        provider: config.provider || 'auto',
      });
      const result = await client.testConnection();
      if (result && result.success) {
        // Group vision models first and suggest a default so the settings page
        // can auto-fill an empty model slot with something sensible. Grouping
        // prefers the endpoint's real capability report (Ollama /api/show
        // "capabilities") over the name heuristic.
        const models = (result.models || []).map((m) => String(m));
        const kind = config.kind === 'local' ? 'local' : 'cloud';
        let probed = null;
        if (LLMClient.isOllamaLikeEndpoint(client.baseUrl)) {
          try {
            probed = await LLMClient.probeVisionForModels(client.baseUrl, client.apiKey, models);
          } catch {
            probed = null;
          }
        }
        const isVision = (m) => {
          const real = probed ? probed.get(m) : null;
          if (real === true) return true;
          if (real === false) return false;
          return LLMClient.modelSupportsVision(m);
        };
        return {
          ...result,
          visionModels: models.filter((m) => isVision(m)),
          otherModels: models.filter((m) => !isVision(m)),
          suggestedModel: LLMClient.pickDefaultModel(kind, models),
        };
      }
      return result;
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
}

module.exports = {
  registerSlidesAnalysisHandlers,
};
