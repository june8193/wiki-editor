import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { createWikiApi } from './wikiApi'

contextBridge.exposeInMainWorld(
  'wikiApi',
  createWikiApi(ipcRenderer, {
    getPathForFile: (file) => webUtils.getPathForFile(file)
  })
)
