import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { ConfigService } from './config/ConfigService'
import { registerConfigIpc } from './ipc/registerConfigIpc'
import { registerWorkspaceIpc } from './ipc/registerWorkspaceIpc'
import { WorkspaceFsService } from './workspace/WorkspaceFsService'
import { createMainWindowOptions } from './window'

function createMainWindow(): BrowserWindow {
  const preloadPath = join(__dirname, '../preload/index.js')
  const mainWindow = new BrowserWindow(createMainWindowOptions(preloadPath))

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

let disposeConfigIpc: (() => void) | undefined
let disposeWorkspaceIpc: (() => void) | undefined
let workspaceService: WorkspaceFsService | undefined

void app.whenReady().then(async () => {
  const configPath = join(app.getPath('userData'), 'config.json')
  const configService = new ConfigService(configPath)
  await configService.get()

  workspaceService = new WorkspaceFsService({
    trashItem: (targetPath) => shell.trashItem(targetPath)
  })

  const getTargets = () => BrowserWindow.getAllWindows().map((win) => win.webContents)

  disposeConfigIpc = registerConfigIpc(ipcMain, configService, getTargets)
  disposeWorkspaceIpc = registerWorkspaceIpc({
    ipcMain,
    workspaceService,
    configService,
    getTargets,
    selectDirectory: async () => {
      const targetWindow = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const options = { properties: ['openDirectory'] as Array<'openDirectory'> }
      const result = targetWindow
        ? await dialog.showOpenDialog(targetWindow, options)
        : await dialog.showOpenDialog(options)
      return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
    }
  })

  createMainWindow()
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('will-quit', () => {
  disposeWorkspaceIpc?.()
  disposeWorkspaceIpc = undefined
  disposeConfigIpc?.()
  disposeConfigIpc = undefined
  workspaceService?.dispose()
  workspaceService = undefined
})
