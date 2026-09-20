const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const LITE_WORKER_EVENT_PREFIX = 'GSBOT_LITE_EVENT ';

function emitLog(event, message, type = 'info') {
  event.sender.send('garment-cleaner-log', {
    time: new Date().toLocaleTimeString(),
    message,
    type,
  });
}

function emitProgress(event, value) {
  event.sender.send('garment-cleaner-progress', Math.max(0, Math.min(100, Number(value) || 0)));
}

function tryParsePrefixedJson(line = '', prefix = '') {
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

function normalizeCleanerMode(value) {
  const mode = String(value || 'hd').trim().toLowerCase();
  return mode === 'lite' ? 'lite' : 'hd';
}

function getLocalRmbgModelSource() {
  return path.join(
    os.homedir(),
    '.cache',
    'huggingface',
    'hub',
    'models--briaai--RMBG-2.0',
    'snapshots',
    '5df4c9c76d8170882c34f6986e848ee07fd0ba43',
  );
}

function getBundledLiteModelPath(runtimeResolver) {
  const bundledRuntime = runtimeResolver.getBundledRmbgRuntimeStatus?.();
  if (!bundledRuntime?.home) {
    return '';
  }
  const candidates = [
    path.join(bundledRuntime.home, 'model.onnx'),
    path.join(path.dirname(bundledRuntime.home), 'rmbg-2.0-lite', 'model.onnx'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

function getLiteWorkerPath(app) {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'rmbg-lite-worker.js')
    : path.join(__dirname, 'rmbg-lite-worker.js');
}

function runLiteOnnxWorker({ app, event, payload, taskController }) {
  return new Promise((resolve) => {
    const workerPath = getLiteWorkerPath(app);
    if (!fs.existsSync(workerPath)) {
      resolve({
        success: false,
        error: `Missing lite worker: ${workerPath}`,
      });
      return;
    }

    const payloadPath = path.join(
      os.tmpdir(),
      `gsbot-lite-rmbg-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
    );
    let workerProcess = null;
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let finalResult = null;
    let finalError = '';

    const cleanup = () => {
      fs.rmSync(payloadPath, { force: true });
      fs.rmSync(`${payloadPath}.cancel`, { force: true });
    };

    try {
      fs.writeFileSync(payloadPath, JSON.stringify(payload), 'utf8');
      workerProcess = spawn(process.execPath, [workerPath, payloadPath], {
        cwd: path.dirname(workerPath),
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      cleanup();
      resolve({
        success: false,
        error: error?.message || String(error),
      });
      return;
    }

    taskController.onCancel(() => {
      emitLog(event, 'Cancellation requested. Stopping lite garment cleaner...', 'warning');
      fs.writeFileSync(`${payloadPath}.cancel`, '1');
      if (workerProcess && !workerProcess.killed) {
        workerProcess.kill('SIGTERM');
        setTimeout(() => {
          if (workerProcess && !workerProcess.killed) {
            workerProcess.kill('SIGKILL');
          }
        }, 1500);
      }
    });

    const consumeLine = (line) => {
      const trimmed = String(line || '').trim();
      if (!trimmed.startsWith(LITE_WORKER_EVENT_PREFIX)) {
        if (trimmed) {
          stderrBuffer += `${trimmed}\n`;
        }
        return;
      }

      try {
        const eventPayload = JSON.parse(trimmed.slice(LITE_WORKER_EVENT_PREFIX.length));
        if (eventPayload.type === 'log') {
          emitLog(event, eventPayload.message, eventPayload.level || 'info');
        } else if (eventPayload.type === 'progress') {
          emitProgress(event, eventPayload.value);
        } else if (eventPayload.type === 'result') {
          finalResult = eventPayload.result;
        } else if (eventPayload.type === 'error') {
          finalError = eventPayload.error || 'Lite RMBG worker failed.';
          if (eventPayload.stack) {
            stderrBuffer += `${eventPayload.stack}\n`;
          }
        }
      } catch (error) {
        stderrBuffer += `${trimmed}\n`;
      }
    };

    workerProcess.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';
      lines.forEach(consumeLine);
    });

    workerProcess.stderr.on('data', (chunk) => {
      stderrBuffer += chunk.toString();
    });

    workerProcess.on('error', (error) => {
      finalError = error?.message || String(error);
    });

    workerProcess.on('close', (code, signal) => {
      if (stdoutBuffer.trim()) {
        consumeLine(stdoutBuffer);
      }
      cleanup();

      if (finalResult) {
        resolve(finalResult);
        return;
      }

      const crashHint = signal ? `signal ${signal}` : `exit code ${code}`;
      resolve({
        success: false,
        error: finalError || `轻量版 ONNX 子进程异常退出（${crashHint}）。App 已保持运行，请切换满血版或重试。`,
        details: stderrBuffer.trim(),
      });
    });
  });
}

function registerGarmentCleanerHandlers({
  ipcMain,
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
  ipcMain.handle('clean-garment-images', async (event, payload = {}) => {
    try {
      assertLicensedForFeature();
    } catch (error) {
      const licenseFailure = getLicenseFailurePayload(error);
      if (licenseFailure) {
        return licenseFailure;
      }
      throw error;
    }

    return runManagedTask(event, 'garment-cleaner', async (taskController) => new Promise(async (resolve) => {
      try {
        let cleanerMode = normalizeCleanerMode(payload?.options?.cleanerMode);
        const bundledRmbgRuntime = runtimeResolver.getBundledRmbgRuntimeStatus?.();
        if (cleanerMode === 'hd' && process.platform === 'win32' && !bundledRmbgRuntime?.ready) {
          cleanerMode = 'lite';
          emitLog(event, 'HD full cutout runtime is not bundled in this light build. Falling back to Lite ONNX mode.', 'warning');
        }
        updateTaskSnapshot(event.sender, 'garment-cleaner', {
          inputPath: String(payload?.sourceFolder || payload?.inputPath || payload?.sourcePath || '').trim(),
          outputPath: String(payload?.outputFolder || '').trim(),
          summary: `Garment cleaner · ${cleanerMode === 'lite' ? 'light ONNX' : 'hybrid HD'}`,
          cacheMode: 'live-run',
        });
        if (cleanerMode === 'lite') {
          const liteModelPath = getBundledLiteModelPath(runtimeResolver);
          if (!liteModelPath) {
            resolve({
              success: false,
              error: '轻量版本 ONNX 模型未内置成功，请先重新打包后再试。',
            });
            return;
          }

          const result = await runLiteOnnxWorker({
            app,
            event,
            payload: {
              ...payload,
              liteModelPath,
            },
            taskController,
          });
          resolve(result);
          return;
        }

        const scriptPath = app.isPackaged
          ? path.join(process.resourcesPath, 'app.asar.unpacked', 'rmbg_python.py')
          : path.join(__dirname, 'rmbg_python.py');

        const pythonRuntime = getPythonRuntime();
        if (!pythonRuntime) {
          resolve({
            success: false,
            error: 'Python 3 was not found. Please install Python 3 before using 挂拍净图.',
          });
          return;
        }

        if (!fs.existsSync(scriptPath)) {
          resolve({
            success: false,
            error: `Missing script: ${scriptPath}`,
          });
          return;
        }

        const localRmbgModelSource = getLocalRmbgModelSource();
        const hfRuntimeHome = path.join(os.tmpdir(), 'gsbot-hf-runtime');
        const pythonEnv = {
          ...runtimeResolver.getPythonSpawnEnv(pythonRuntime),
          HF_HOME: hfRuntimeHome,
          HUGGINGFACE_HUB_CACHE: path.join(hfRuntimeHome, 'hub'),
          TRANSFORMERS_CACHE: path.join(hfRuntimeHome, 'transformers'),
          HF_MODULES_CACHE: path.join(hfRuntimeHome, 'modules'),
        };

        let pythonProcess = null;
        let outputData = '';
        let errorData = '';
        let finalResult = null;

        taskController.onCancel(() => {
          emitLog(event, 'Cancellation requested. Stopping garment cleaner...', 'warning');
          if (pythonProcess && !pythonProcess.killed) {
            pythonProcess.kill('SIGTERM');
            setTimeout(() => {
              if (pythonProcess && !pythonProcess.killed) {
                pythonProcess.kill('SIGKILL');
              }
            }, 1500);
          }
        });

        pythonProcess = spawn(
          pythonRuntime.command,
          [...pythonRuntime.args, scriptPath],
          {
            windowsHide: true,
            env: pythonEnv,
          },
        );

        pythonProcess.stdin.setDefaultEncoding('utf8');
        pythonProcess.stdin.write(JSON.stringify({
          ...payload,
          options: {
            ...(payload.options || {}),
            cleanerMode: 'hd',
          },
          rmbgModelSource: bundledRmbgRuntime?.ready
            ? bundledRmbgRuntime.home
            : (fs.existsSync(localRmbgModelSource) ? localRmbgModelSource : 'briaai/RMBG-2.0'),
        }), 'utf8');
        pythonProcess.stdin.end();

        pythonProcess.stdout.on('data', (data) => {
          const text = data.toString();
          outputData += text;
          text.split('\n').forEach((line) => {
            const progressPayload = tryParsePrefixedJson(line, 'GS_PROGRESS:');
            if (progressPayload && typeof progressPayload.value !== 'undefined') {
              emitProgress(event, progressPayload.value);
              return;
            }

            const resultPayload = tryParsePrefixedJson(line, 'GS_RESULT:');
            if (resultPayload) {
              finalResult = resultPayload;
              return;
            }

            const logPayload = tryParsePrefixedJson(line, 'GS_LOG:');
            if (logPayload?.message) {
              emitLog(event, logPayload.message, logPayload.type || 'info');
              return;
            }

            const trimmed = line.trim();
            if (trimmed) {
              emitLog(event, trimmed, 'info');
            }
          });
        });

        pythonProcess.stderr.on('data', (data) => {
          errorData += data.toString();
        });

        pythonProcess.on('close', (code) => {
          if (taskController.cancelled) {
            resolve({
              success: false,
              cancelled: true,
              error: 'Garment cleaning cancelled by user.',
            });
            return;
          }

          if (code === 0) {
            resolve(finalResult || {
              success: true,
              outputPath: payload.outputFolder || '',
              rawOutput: outputData,
            });
            return;
          }

          resolve({
            success: false,
            error: errorData || `Python script exited with code ${code}`,
          });
        });

        pythonProcess.on('error', (error) => {
          resolve({
            success: false,
            error: `Failed to start Python: ${error.message}. Please install Python 3.`,
          });
        });
      } catch (error) {
        resolve({
          success: false,
          error: error?.message || String(error),
        });
      }
    }), activeTaskControllers);
  });
}

module.exports = {
  registerGarmentCleanerHandlers,
};
