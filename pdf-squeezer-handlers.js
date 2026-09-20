const { spawn } = require('child_process');

function emitLog(event, message, type = 'info') {
  event.sender.send('pdf-squeezer-log', {
    time: new Date().toLocaleTimeString(),
    message,
    type,
  });
}

function emitProgress(event, value) {
  event.sender.send('pdf-squeezer-progress', Math.max(0, Math.min(100, Number(value) || 0)));
}

function emitItem(event, value) {
  event.sender.send('pdf-squeezer-item', value);
}

function tryParseResultFromOutput(outputData = '') {
  const lines = String(outputData || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.startsWith('{') || !line.endsWith('}')) {
      continue;
    }
    try {
      return JSON.parse(line);
    } catch {}
  }

  return null;
}

function tryParsePrefixedJsonLine(line = '', prefix = '') {
  const trimmed = String(line || '').trim();
  if (!trimmed.startsWith(prefix)) {
    return null;
  }

  try {
    return JSON.parse(trimmed.slice(prefix.length));
  } catch {
    return null;
  }
}

function ensureUniquePath(fs, path, targetPath) {
  let candidate = String(targetPath || '').trim();
  if (!candidate) {
    return candidate;
  }

  if (!fs.existsSync(candidate)) {
    return candidate;
  }

  const parsed = path.parse(candidate);
  let counter = 1;
  while (true) {
    const nextCandidate = path.join(parsed.dir, `${parsed.name}(${counter})${parsed.ext}`);
    if (!fs.existsSync(nextCandidate)) {
      return nextCandidate;
    }
    counter += 1;
  }
}

function normalizeIncomingPdfPath(rawValue = '') {
  let nextValue = String(rawValue || '').trim();
  if (!nextValue) {
    return '';
  }

  if (
    (nextValue.startsWith('"') && nextValue.endsWith('"'))
    || (nextValue.startsWith('\'') && nextValue.endsWith('\''))
  ) {
    nextValue = nextValue.slice(1, -1).trim();
  }

  if (/^file:\/\//i.test(nextValue)) {
    try {
      nextValue = decodeURIComponent(nextValue.replace(/^file:\/\//i, ''));
    } catch {
      nextValue = nextValue.replace(/^file:\/\//i, '');
    }
  }

  if (nextValue.startsWith('/')) {
    nextValue = nextValue.replace(/\\([ !"#$&'()*;<>?\[\]{}|`~])/g, '$1');
  }

  return nextValue;
}

function resolvePdfSourceEntries(fs, path, inputPaths = []) {
  const results = [];
  const seen = new Set();

  const visit = (targetPath) => {
    const normalized = normalizeIncomingPdfPath(targetPath);
    if (!normalized) {
      return;
    }

    let resolvedPath = normalized;
    try {
      resolvedPath = path.resolve(normalized);
    } catch {
      return;
    }

    if (seen.has(resolvedPath)) {
      return;
    }
    seen.add(resolvedPath);

    let stats;
    try {
      stats = fs.statSync(resolvedPath);
    } catch {
      return;
    }

    if (stats.isDirectory()) {
      let entries = [];
      try {
        entries = fs.readdirSync(resolvedPath, { withFileTypes: true });
      } catch {
        return;
      }

      entries
        .slice()
        .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' }))
        .forEach((entry) => visit(path.join(resolvedPath, entry.name)));
      return;
    }

    if (!stats.isFile() || path.extname(resolvedPath).toLowerCase() !== '.pdf') {
      return;
    }

    results.push({
      path: resolvedPath,
      name: path.basename(resolvedPath),
      parentPath: path.dirname(resolvedPath),
      originalBytes: stats.size,
    });
  };

  (Array.isArray(inputPaths) ? inputPaths : []).forEach(visit);

  return results.sort((left, right) => (
    left.path.localeCompare(right.path, undefined, { numeric: true, sensitivity: 'base' })
  ));
}

function buildTemporaryOutputFolder(app, fs, path) {
  const nextFolder = path.join(
    app.getPath('temp'),
    'gsbot-pdf-squeezer',
    `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  fs.mkdirSync(nextFolder, { recursive: true });
  return nextFolder;
}

function copyIntoPath(fs, path, sourcePath, targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
}

function registerPdfSqueezerHandlers({
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
}) {
  ipcMain.handle('select-pdf-files', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'PDF Files', extensions: ['pdf'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    return canceled ? [] : filePaths;
  });

  ipcMain.handle('select-pdf-folders', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openDirectory', 'multiSelections'],
    });
    return canceled ? [] : resolvePdfSourceEntries(fs, path, filePaths);
  });

  ipcMain.handle('select-pdf-sources', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openFile', 'openDirectory', 'multiSelections'],
      filters: [
        { name: 'PDF Files', extensions: ['pdf'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    return canceled ? [] : resolvePdfSourceEntries(fs, path, filePaths);
  });

  ipcMain.handle('resolve-pdf-sources', async (_event, inputPaths = []) => {
    return resolvePdfSourceEntries(fs, path, inputPaths);
  });

  ipcMain.handle('save-squeezed-pdfs', async (_event, payload = {}) => {
    try {
      assertLicensedForFeature();
    } catch (error) {
      const licenseFailure = getLicenseFailurePayload(error);
      if (licenseFailure) {
        return licenseFailure;
      }
      throw error;
    }

    try {
      const items = (Array.isArray(payload.items) ? payload.items : [])
        .map((item) => ({
          sourcePath: String(item?.sourcePath || '').trim(),
          stagedPath: String(item?.stagedPath || '').trim(),
          name: String(item?.name || '').trim(),
        }))
        .filter((item) => item.sourcePath && item.stagedPath && fs.existsSync(item.stagedPath));

      if (!items.length) {
        return { success: false, error: 'No compressed PDFs are ready to save.' };
      }

      const mode = payload.mode === 'overwrite' ? 'overwrite' : 'save-as';
      const savedPaths = [];

      if (mode === 'overwrite') {
        items.forEach((item) => {
          copyIntoPath(fs, path, item.stagedPath, item.sourcePath);
          savedPaths.push(item.sourcePath);
        });
      } else if (items.length === 1) {
        const targetPath = String(payload.targetPath || '').trim();
        if (!targetPath) {
          return { success: false, error: 'No save destination was selected.' };
        }
        copyIntoPath(fs, path, items[0].stagedPath, targetPath);
        savedPaths.push(targetPath);
      } else {
        const targetFolder = String(payload.targetFolder || '').trim();
        if (!targetFolder) {
          return { success: false, error: 'No target folder was selected.' };
        }

        fs.mkdirSync(targetFolder, { recursive: true });
        items.forEach((item) => {
          const desiredTarget = path.join(targetFolder, path.basename(item.sourcePath));
          const targetPath = ensureUniquePath(fs, path, desiredTarget);
          copyIntoPath(fs, path, item.stagedPath, targetPath);
          savedPaths.push(targetPath);
        });
      }

      return {
        success: true,
        mode,
        savedCount: savedPaths.length,
        savedPaths,
        outputPath: savedPaths.length === 1 ? savedPaths[0] : path.dirname(savedPaths[0]),
      };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('squeeze-pdfs', async (event, payload = {}) => {
    try {
      assertLicensedForFeature();
    } catch (error) {
      const licenseFailure = getLicenseFailurePayload(error);
      if (licenseFailure) {
        return licenseFailure;
      }
      throw error;
    }

    return runManagedTask(event, 'pdf-squeezer', async (taskController) => new Promise((resolve) => {
      const pythonRuntime = getPythonRuntime();
      const inputPaths = Array.isArray(payload?.inputPaths) ? payload.inputPaths : [];
      const normalizedInputs = inputPaths
        .map((item) => normalizeIncomingPdfPath(item))
        .filter(Boolean);
      updateTaskSnapshot(event.sender, 'pdf-squeezer', {
        inputPath: normalizedInputs.length === 1 ? normalizedInputs[0] : (normalizedInputs[0] || `${normalizedInputs.length} PDF sources`),
        outputPath: String(payload?.outputFolder || '').trim(),
        summary: `PDF Squeezer · ${normalizedInputs.length || 0} file${normalizedInputs.length === 1 ? '' : 's'}`,
        cacheMode: 'live-run',
      });
      if (!pythonRuntime) {
        resolve({
          success: false,
          error: 'Python 3 was not found. Please install Python 3 and Pillow before using PDF Squeezer.',
        });
        return;
      }

      const scriptPath = app.isPackaged
        ? path.join(process.resourcesPath, 'app.asar.unpacked', 'pdf_squeezer.py')
        : path.join(__dirname, 'pdf_squeezer.py');

      if (!fs.existsSync(scriptPath)) {
        resolve({
          success: false,
          error: `PDF Squeezer script was not found at ${scriptPath}`,
        });
        return;
      }

      const pythonEnv = {
        ...runtimeResolver.getPythonSpawnEnv(pythonRuntime),
      };

      const stagedOutputFolder = String(payload.outputFolder || '').trim() || buildTemporaryOutputFolder(app, fs, path);

      let pythonProcess = null;
      let outputData = '';
      let errorData = '';
      let stdoutBuffer = '';

      taskController.onCancel(() => {
        emitLog(event, 'Cancellation requested. Stopping PDF Squeezer...', 'warning');

        if (pythonProcess && !pythonProcess.killed) {
          pythonProcess.kill('SIGTERM');
          setTimeout(() => {
            if (pythonProcess && !pythonProcess.killed) {
              pythonProcess.kill('SIGKILL');
            }
          }, 1500);
        }
      });

      try {
        emitLog(event, 'Starting PDF Squeezer...', 'info');
        emitProgress(event, 4);

        pythonProcess = spawn(
          pythonRuntime.command,
          [...pythonRuntime.args, scriptPath],
          {
            windowsHide: true,
            env: pythonEnv,
          },
        );

        const requestPayload = {
          ...payload,
          outputFolder: stagedOutputFolder,
        };

        pythonProcess.stdin.setDefaultEncoding('utf8');
        pythonProcess.stdin.write(JSON.stringify(requestPayload), 'utf8');
        pythonProcess.stdin.end();

        const flushStdoutLines = (isFinal = false) => {
          const lines = stdoutBuffer.split(/\r?\n/);
          stdoutBuffer = isFinal ? '' : lines.pop() || '';

          lines.forEach((line) => {
            const trimmed = String(line || '').trim();
            if (!trimmed) {
              return;
            }

            if (trimmed.startsWith('__PROGRESS__:')) {
              emitProgress(event, Number(trimmed.replace('__PROGRESS__:', '').trim()));
              return;
            }

            const itemPayload = tryParsePrefixedJsonLine(trimmed, '__FILE_RESULT__:');
            if (itemPayload) {
              emitItem(event, itemPayload);
              return;
            }

            emitLog(event, trimmed, 'info');
          });
        };

        pythonProcess.stdout.on('data', (data) => {
          const output = data.toString();
          outputData += output;
          stdoutBuffer += output;
          flushStdoutLines(false);
        });

        pythonProcess.stderr.on('data', (data) => {
          const message = data.toString();
          errorData += message;
          console.error('PDF Squeezer error:', message);
        });

        pythonProcess.on('close', (code) => {
          flushStdoutLines(true);

          if (taskController.cancelled) {
            resolve({
              success: false,
              cancelled: true,
              error: 'PDF compression cancelled by user.',
            });
            return;
          }

          if (code === 0) {
            const result = tryParseResultFromOutput(outputData);
            if (result) {
              resolve({
                ...result,
                stagingFolder: stagedOutputFolder,
              });
              return;
            }

            resolve({
              success: true,
              outputFolder: stagedOutputFolder,
              stagingFolder: stagedOutputFolder,
              outputPaths: [],
              fileCount: 0,
            });
            return;
          }

          resolve({
            success: false,
            error: errorData || `PDF Squeezer exited with code ${code}`,
          });
        });

        pythonProcess.on('error', (error) => {
          resolve({
            success: false,
            error: `Failed to start Python: ${error.message}. Please install Python 3 and Pillow.`,
          });
        });
      } catch (error) {
        resolve({
          success: false,
          error: error.message || String(error),
        });
      }
    }), activeTaskControllers);
  });
}

module.exports = {
  registerPdfSqueezerHandlers,
  __private: {
    normalizeIncomingPdfPath,
    resolvePdfSourceEntries,
  },
};
