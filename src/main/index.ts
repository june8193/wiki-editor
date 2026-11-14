import { join } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { ConfigService } from './config/ConfigService'
import { registerConfigIpc } from './ipc/registerConfigIpc'
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

void app.whenReady().then(async () => {
  const configPath = join(app.getPath('userData'), 'config.json')
  const configService = new ConfigService(configPath)
  await configService.get()

  disposeConfigIpc = registerConfigIpc(ipcMain, configService, () =>
    BrowserWindow.getAllWindows().map((win) => win.webContents)
  )

  createMainWindow()
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('will-quit', () => {
  disposeConfigIpc?.()
  disposeConfigIpc = undefined
})
