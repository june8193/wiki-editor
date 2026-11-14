import { contextBridge, ipcRenderer } from 'electron'
import { createWikiApi } from './wikiApi'

contextBridge.exposeInMainWorld('wikiApi', createWikiApi(ipcRenderer))
