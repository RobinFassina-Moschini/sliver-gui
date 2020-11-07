/*
  Sliver Implant Framework
  Copyright (C) 2019  Bishop Fox
  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.
  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.
  You should have received a copy of the GNU General Public License
  along with this program.  If not, see <https://www.gnu.org/licenses/>.
--------------------------------------------------------------------------

Maps IPC calls to RPC calls, and provides other local operations such as
listing/selecting configs to the sandboxed code.

*/

import { ipcMain, dialog, FileFilter, BrowserWindow, IpcMainEvent, TouchBarOtherItemsProxy } from 'electron';
import { homedir } from 'os';
import { Base64 } from 'js-base64';

import * as fs from 'fs';
import * as path from 'path';
import * as uuid from 'uuid';

import { jsonSchema } from './json-schema';
import { isConnected } from './is-connected';
import { SliverClient, SliverClientConfig } from 'sliver-script';

import * as clientpb from 'sliver-script/lib/pb/clientpb/client_pb';
import * as sliverpb from 'sliver-script/lib/pb/sliverpb/sliver_pb';

import { WorkerManager } from '../workers/worker-manager';


const CLIENT_DIR = path.join(homedir(), '.sliver-client');
const CONFIG_DIR = path.join(CLIENT_DIR, 'configs');
const SETTINGS_PATH = path.join(CLIENT_DIR, 'gui-settings.json');


export interface SaveFileReq {
  title: string;
  message: string;
  filename: string;
  data: string;
}

export interface ReadFileReq {
  title: string;
  message: string;
  openDirectory: boolean;
  multiSelections: boolean;
  filters: FileFilter[] | null; // { filters: [ { name: 'Custom File Type', extensions: ['as'] } ] }
}

export interface IPCMessage {
  id: number;
  type: string;
  method: string; // Identifies the target method and in the response if the method call was a success/error
  data: string;
}


async function makeConfigDir(): Promise<NodeJS.ErrnoException|null> {
  return new Promise((resolve, reject) => {
    const dirOptions = {
      mode: 0o700, 
      recursive: true
    };
    fs.mkdir(CONFIG_DIR, dirOptions, (err) => {
      err ? reject(err) : resolve(null);
    });
  });
}


/*
 - IPC Methods used to start/interact with the RPCClient
  
  If you're wondering why each method has a `self` argument, it's because TypeScript
  inherits the `this` keyword from JavaScript, and JavaScript is a *fucking stupid*
  language. Because of the indirection in the calls to these methods, there's no way
  to reference the object instance, and no bind() / call() don't work in this case,
  because again JavaScript is *fucking awful* --why anyone likes this shitty fucking
  programming language is beyond human comprehension.
*/
export class IPCHandlers {

  public client: SliverClient;
  private _workerManager: WorkerManager;

  constructor(workerManager: WorkerManager) {
    this._workerManager = workerManager;
  }

  // ----------
  // > Script
  // ----------
  @isConnected()
  @jsonSchema({
    "type": "object",
    "properties": {
      "code": {"type": "string"},
    },
    "required": ["code"],
    "additionalProperties": false,
  })
  async script_execute(self: IPCHandlers, req: any): Promise<string> {
    let execId = await self._workerManager.startScriptExecution(req.code);
    return execId;
  }


  // ----------
  // > RPC
  // ----------

  // Sessions / Implants

  @isConnected()
  async rpc_sessions(self: IPCHandlers): Promise<string[]> {
    let sessions = await self.client.sessions();
    return sessions.map(session => Base64.fromUint8Array(session.serializeBinary()));
  }

  @isConnected()
  @jsonSchema({
    "type": "object",
    "properties": {
      "id": {"type": "number"},
    },
    "required": ["id"],
    "additionalProperties": false,
  })
  async rpc_sessionById(self: IPCHandlers, req: any): Promise<string> {
    let sessionId = req.id;
    // Remember JS is *terrible* and any direct compares to NaN will
    // return false, for example `sessionId == NaN` is always false
    if (isNaN(sessionId) || sessionId <= 0) {
      return '';
    }
    let sessions = await self.client.sessions();
    for (let index = 0; index < sessions.length; ++index) {
      if (sessions[index].getId() === sessionId) {
        return Base64.fromUint8Array(sessions[index].serializeBinary());
      }
    }
    return '';
  }

  @isConnected()
  async rpc_implantBuilds(self: IPCHandlers): Promise<string>  {
    let builds = await self.client.implantBuilds();
    return Base64.fromUint8Array(builds.serializeBinary());
  }

  @isConnected()
  async rpc_canaries(self: IPCHandlers): Promise<string[]>  {
    let canaries = await self.client.canaries();
    return canaries.map(canary => Base64.fromUint8Array(canary.serializeBinary()));
  }

  @isConnected()
  @jsonSchema({
    "type": "object",
    "properties": {
      "config": {"type": "string", "minLength": 1},
    },
    "required": ["config"],
    "additionalProperties": false
  })
  async rpc_generate(self: IPCHandlers, req: any): Promise<string> {
    let config = clientpb.ImplantConfig.deserializeBinary(Base64.toUint8Array(req.config));
    let generated = await self.client.generate(config);
    return Base64.fromUint8Array(generated.serializeBinary());
  }

  @isConnected()
  @jsonSchema({
    "type": "object",
    "properties": {
      "name": {"type": "string", "minLength": 1},
    },
    "required": ["name"],
    "additionalProperties": false,
  })
  async rpc_regenerate(self: IPCHandlers, req: any): Promise<string> {
    let regenerated = await self.client.regenerate(req.name);
    return Base64.fromUint8Array(regenerated.serializeBinary());
  }

  // Session Interaction
  @isConnected()
  @jsonSchema({
    "type": "object",
    "properties": {
      "sessionId": {"type": "number"}
    },
    "required": ["sessionId"],
    "additionalProperties": false,
  })
  async rpc_ps(self: IPCHandlers, req: any): Promise<string[]> {
    let session = await self.client.interact(req.sessionId);
    let ps = await session.ps();
    return ps.map(p => Base64.fromUint8Array(p.serializeBinary()));
  }

  @isConnected()
  @jsonSchema({
    "type": "object",
    "properties": {
      "sessionId": {"type": "number"},
      "targetDir": {"type": "string"},
    },
    "required": ["sessionId"],
    "additionalProperties": false,
  })
  async rpc_ls(self: IPCHandlers, req: any): Promise<string> {
    let session = await self.client.interact(req.sessionId);
    let ls = await session.ls(req.targetDir);
    return Base64.fromUint8Array(ls.serializeBinary());
  }

  @isConnected()
  @jsonSchema({
    "type": "object",
    "properties": {
      "sessionId": {"type": "number"},
      "targetDir": {"type": "string"},
    },
    "required": ["sessionId"],
    "additionalProperties": false,
  })
  async rpc_cd(self: IPCHandlers, req: any): Promise<string> {
    let session = await self.client.interact(req.sessionId);
    let cd = await session.cd(req.targetDir);
    return Base64.fromUint8Array(cd.serializeBinary());
  }

  @isConnected()
  @jsonSchema({
    "type": "object",
    "properties": {
      "sessionId": {"type": "number"},
      "target": {"type": "string"},
    },
    "required": ["sessionId"],
    "additionalProperties": false,
  })
  async rpc_rm(self: IPCHandlers, req: any): Promise<string> {
    let session = await self.client.interact(req.sessionId);
    let rm = await session.rm(req.target);
    return Base64.fromUint8Array(rm.serializeBinary());
  }

  @isConnected()
  @jsonSchema({
    "type": "object",
    "properties": {
      "sessionId": {"type": "number"},
      "targetDir": {"type": "string"},
    },
    "required": ["sessionId"],
    "additionalProperties": false,
  })
  async rpc_mkdir(self: IPCHandlers, req: any): Promise<string> {
    let session = await self.client.interact(req.sessionId);
    let mkdir = await session.mkdir(req.targetDir);
    return Base64.fromUint8Array(mkdir.serializeBinary());
  }

  @isConnected()
  @jsonSchema({
    "type": "object",
    "properties": {
      "sessionId": {"type": "number"},
      "target": {"type": "string"},
    },
    "required": ["sessionId"],
    "additionalProperties": false,
  })
  async rpc_download(self: IPCHandlers, req: any): Promise<string> {
    let session = await self.client.interact(req.sessionId);
    let data = await session.download(req.target);
    return Base64.fromUint8Array(data);
  }
  
  @isConnected()
  @jsonSchema({
    "type": "object",
    "properties": {
      "sessionId": {"type": "number"},
      "data": {"type": "string"},
      "path": {"type": "string"},
    },
    "required": ["sessionId"],
    "additionalProperties": false,
  })
  async rpc_upload(self: IPCHandlers, req: any): Promise<string> {
    let session = await self.client.interact(req.sessionId);
    let data = Base64.toUint8Array(req.data);
    let upload = await session.upload(req.path, Buffer.from(data));
    return Base64.fromUint8Array(upload.serializeBinary());
  }

  @isConnected()
  @jsonSchema({
    "type": "object",
    "properties": {
      "sessionId": {"type": "number"},
    },
    "required": ["sessionId"],
    "additionalProperties": false,
  })
  async rpc_ifconfig(self: IPCHandlers, req: any): Promise<string> {
    let session = await self.client.interact(req.sessionId);
    let ifconfig = await session.ifconfig();
    return Base64.fromUint8Array(ifconfig.serializeBinary());
  }

  // Jobs
  @isConnected()
  async rpc_jobs(self: IPCHandlers): Promise<string[]> {
    let jobs = await self.client.jobs();
    return jobs.map(job => Base64.fromUint8Array(job.serializeBinary()));
  }

  @isConnected()
  @jsonSchema({
    "type": "object",
    "properties": {
      "id": {"type": "number"},
    },
    "required": ["id"],
    "additionalProperties": false,
  })
  async rpc_jobById(self: IPCHandlers, req: any): Promise<string> {
    let jobId = req.id;
    if (isNaN(jobId) || jobId <= 0) {
      return '';
    }
    let jobs = await self.client.jobs();
    for (let index = 0; index < jobs.length; ++index) {
      if (jobs[index].getId() === jobId) {
        return Base64.fromUint8Array(jobs[index].serializeBinary());
      }
    }
    return '';
  }

  @isConnected()
  @jsonSchema({
    "type": "object",
    "properties": {
      "host": {"type": "string"},
      "port": {"type": "number"},
    },
    "required": ["host", "port"],
    "additionalProperties": false,
  })
  async rpc_startMTLSListener(self: IPCHandlers, req: any): Promise<string> {
    let job = await self.client.startMTLSListener(req.host, req.port);
    return Base64.fromUint8Array(job.serializeBinary());
  }

  @isConnected()
  @jsonSchema({
    "type": "object",
    "properties": {
      "host": {"type": "string"},
      "domain": {"type": "string"},
      "website": {"type": "string"},
      "port": {"type": "number"},
    },
    "required": ["host", "port"],
    "additionalProperties": false,
  })
  async rpc_startHTTPListener(self: IPCHandlers, req: any): Promise<string> {
    let job = await self.client.startHTTPListener(req.domain, req.host, req.port, req.website);
    return Base64.fromUint8Array(job.serializeBinary());
  }

  @isConnected()
  @jsonSchema({
    "type": "object",
    "properties": {
      "host": {"type": "string"},
      "domain": {"type": "string"},
      "website": {"type": "string"},
      "port": {"type": "number"},
      "acme": {"type": "boolean"},
      "cert": {"type": "string"},
      "key": {"type": "string"}
    },
    "required": ["host", "port"],
    "additionalProperties": false,
  })
  async rpc_startHTTPSListener(self: IPCHandlers, req: any): Promise<string> {
    let job = await self.client.startHTTPSListener(req.domain, req.host, req.port, req.acme, req.website, req.cert, req.key);
    return Base64.fromUint8Array(job.serializeBinary());
  }

  @isConnected()
  @jsonSchema({
    "type": "object",
    "properties": {
      "domains": {
        "type": "array",
        "items": {"type": "string"},
        "additionalItems": false,
      },
      "canaries": {"type": "boolean"},
      "host": {"type": "string"},
      "port": {"type": "number"},
    },
    "required": ["host", "port"],
    "additionalProperties": false,
  })
  async rpc_startDNSListener(self: IPCHandlers, req: any): Promise<string> {
    let job = await self.client.startDNSListener(req.domains, req.canaries, req.host, req.port);
    return Base64.fromUint8Array(job.serializeBinary());
  }

  // ----------
  // > Config
  // ----------

  public config_list(self: IPCHandlers): Promise<string> {
    return new Promise((resolve) => {
      fs.readdir(CONFIG_DIR, (_, items) => {
        if (!fs.existsSync(CONFIG_DIR) || items === undefined) {
          return resolve(JSON.stringify([]));
        }
        const configs: SliverClientConfig[] = [];
        for (let index = 0; index < items.length; ++index) {
          const filePath = path.join(CONFIG_DIR, items[index]);
          if (fs.existsSync(filePath) && !fs.lstatSync(filePath).isDirectory()) {
            const fileData = fs.readFileSync(filePath);
            configs.push(JSON.parse(fileData.toString('utf8')));
          }
        }
        resolve(JSON.stringify(configs));
      });
    });
  }

  @jsonSchema({
    "type": "object",
    "properties": {
      "configs": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "operator": {"type": "string", "minLength": 1},
            "lhost": {"type": "string", "minLength": 1},
            "lport": {"type": "number"},
            "ca_certificate": {"type": "string", "minLength": 1},
            "certificate": {"type": "string", "minLength": 1},
            "private_key": {"type": "string", "minLength": 1},
          },
          "additionalProperties": false,
        },
      },
    },
    "required": ["configs"],
    "additionalProperties": false,
  })
  async config_save(self: IPCHandlers, req: any): Promise<string> {
    const configs: SliverClientConfig[] = req.configs;
    if (!fs.existsSync(CONFIG_DIR)) {
      const err = await makeConfigDir();
      if (err) {
        return Promise.reject(`Failed to create config dir: ${err}`);
      }
    }
    const fileOptions = {
      mode: 0o600,
      encoding: 'utf-8',
    };

    await Promise.all(configs.map((config) => { 
      return new Promise((resolve) => {
        const fileName: string = uuid.v4();
        const data = JSON.stringify(config);
        fs.writeFile(path.join(CONFIG_DIR, fileName), data, fileOptions, (err) => {
          if (err) {
            console.error(err);
          }
          resolve();
        });
      });
    }));

    return self.config_list(self);
  }

  // ----------
  // > Client
  // ----------

  @jsonSchema({
    "type": "object",
    "properties": {
      "operator": {"type": "string", "minLength": 1},
      "lhost": {"type": "string", "minLength": 1},
      "lport": {"type": "number"},
      "ca_certificate": {"type": "string", "minLength": 1},
      "certificate": {"type": "string", "minLength": 1},
      "private_key": {"type": "string", "minLength": 1},
    },
    "required": [
      "operator", "lhost", "lport", "ca_certificate", "certificate", "private_key"
    ],
    "additionalProperties": false,
  })
  public async client_start(self: IPCHandlers, config: SliverClientConfig): Promise<string> {
    self.client = new SliverClient(config);
    await self.client.connect();
    console.log('Connection successful');

    // Pipe realtime events back to renderer process
    self.client.event$.subscribe((event) => {
      ipcMain.emit('push', Base64.fromUint8Array(event.serializeBinary()));
    });

    return 'success';
  }

  public async client_activeConfig(self: IPCHandlers): Promise<string> {
    return self.client ? JSON.stringify(self.client.config) : '';
  }

  @jsonSchema({
    "type": "object",
    "properties": {
      "title": {"type": "string", "minLength": 1, "maxLength": 100},
      "message": {"type": "string", "minLength": 1, "maxLength": 100},
      "openDirectory": {"type": "boolean"},
      "multiSelection": {"type": "boolean"},
      "filter": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "name": {"type": "string"},
            "extensions": {
              "type": "array",
              "items": {"type": "string"},
              "additionalItems": false,
            }
          },
          "additionalProperties": false,
        }
      }
    },
    "required": ["title", "message"],
    "additionalProperties": false,
  })
  public async client_readFile(self: IPCHandlers, readFileReq: ReadFileReq): Promise<string> {
    const dialogOptions = {
      title: readFileReq.title,
      message: readFileReq.message,
      openDirectory: readFileReq.openDirectory,
      multiSelections: readFileReq.multiSelections
    };
    const files = [];
    const open = await dialog.showOpenDialog(null, dialogOptions);
    await Promise.all(open.filePaths.map((filePath) => {
      return new Promise(async (resolve) => {
        fs.readFile(filePath, (err, data) => {
          files.push({
            filePath: filePath,
            error: err ? err.toString() : null,
            data: data ? Base64.fromUint8Array(data) : null
          });
          resolve();
        });
      });
    }));
    return JSON.stringify({ files: files });
  }

  @jsonSchema({
    "type": "object",
    "properties": {
      "title": {"type": "string", "minLength": 1, "maxLength": 100},
      "message": {"type": "string", "minLength": 1, "maxLength": 100},
      "filename": {"type": "string", "minLength": 1},
      "data": {"type": "string"}
    },
    "required": ["title", "message", "filename", "data"],
    "additionalProperties": false,
  })
  public client_saveFile(self: IPCHandlers, saveFileReq: SaveFileReq): Promise<string> {
    return new Promise(async (resolve, reject) => {
      const dialogOptions = {
        title: saveFileReq.title,
        message: saveFileReq.message,
        defaultPath: path.join(homedir(), 'Downloads', path.basename(saveFileReq.filename)),
      };
      const save = await dialog.showSaveDialog(dialogOptions);
      console.log(`[save file] ${save.filePath}`);
      if (save.canceled) {
        return resolve('');  // Must return to stop execution
      }
      const fileOptions = {
        mode: 0o644,
        encoding: 'binary',
      };
      const data = Buffer.from(Base64.decode(saveFileReq.data));
      fs.writeFile(save.filePath, data, fileOptions, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve(JSON.stringify({ filename: save.filePath }));
        }
      });
    });
  }

  public client_getSettings(self: IPCHandlers): Promise<string> {
    return new Promise((resolve, reject) => {
      try {
        if (!fs.existsSync(SETTINGS_PATH)) {
          return resolve('{}');
        }
        fs.readFile(SETTINGS_PATH, 'utf-8', (err, data) => {
          if (err) {
            return reject(err);
          }
          JSON.parse(data);
          resolve(data);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  // The Node process never interacts with the "settings" values, so
  // we do not validate them, aside from ensuing it's valid JSON
  public client_saveSettings(self: IPCHandlers, settings: string): Promise<string> {
    return new Promise(async (resolve, reject) => {
      
      if (!fs.existsSync(CONFIG_DIR)) {
        const err = await makeConfigDir();
        if (err) {
          return reject(`Failed to create config dir: ${err}`);
        }
      }

      const fileOptions = {
        mode: 0o600,
        encoding: 'utf-8',
      };
      try {
        JSON.parse(settings); // Just ensure it's valid JSON
        fs.writeFile(SETTINGS_PATH, settings, fileOptions, async (err) => {
          if (err) {
            reject(err);
          } else {
            const updated = await self.client_getSettings(self);
            resolve(updated);
          }
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  public client_exit(self: IPCHandlers) {
    process.on('unhandledRejection', () => { }); // STFU Node
    process.exit(0);
  }

}

async function dispatchIPC(handlers: IPCHandlers, method: string, data: string): Promise<any> {
  console.log(`IPC Dispatch: ${method}`);

  // IPC handlers must start with "namespace_" this helps ensure we do not inadvertently
  // expose methods that we don't want exposed to the sandboxed code.
  if (['client_', 'config_', 'rpc_', 'script_'].some(prefix => method.startsWith(prefix))) {
    if (typeof handlers[method] === 'function') {
      const result: any = await handlers[method](handlers, data);
      return result;
    } else {
      return Promise.reject(`No handler for method: ${method}`);
    }
  } else {
    return Promise.reject(`Invalid method handler namespace for "${method}"`);
  }
}

export function startIPCHandlers(window: BrowserWindow, handlers: IPCHandlers) {

  ipcMain.on('ipc', async (event: IpcMainEvent, msg: IPCMessage) => {
    dispatchIPC(handlers, msg.method, msg.data).then((result: any) => {
      if (msg.id !== 0) {
        event.sender.send('ipc', {
          id: msg.id,
          type: 'response',
          method: 'success',
          data: result
        });
      }
    }).catch((err) => {
      console.error(`[ipc handlers] ${err}`);
      console.trace();
      if (msg.id !== 0) {
        event.sender.send('ipc', {
          id: msg.id,
          type: 'response',
          method: 'error',
          data: err.toString()
        });
      }
    });
  });

  // This one doesn't have an event argument for some reason ...
  ipcMain.on('push', async (_: IpcMainEvent, data: string) => {
    window.webContents.send('ipc', {
      id: 0,
      type: 'push',
      method: '',
      data: data
    });
  });

}
