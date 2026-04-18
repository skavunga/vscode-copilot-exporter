/**
 * @Author: Fengze Han
 * @Date:   2025-09-24 00:14:34
 * @Last Modified by:   Fengze Han
 * @Last Modified time: 2025-09-24 10:45:39
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { promisify } from 'util';

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const mkdir = promisify(fs.mkdir);

interface CopilotEntry {
  key: string;
  content: any;
  timestamp?: string;
  workspace?: string;
  type?: string;
}

interface WorkspaceCandidate {
  workspaceDir: string;
  chatSessionsPath: string;
  sessionFiles: string[];
  mostRecentTime: number;
  workspaceFolderPath?: string;
}

function cleanText(text: string): string {
  if (!text) return '';
  
  return text
    // Remove technical markers and symbols
    .replace(/```[\w]*\n?/g, '') // Remove code block markers
    .replace(/`([^`]+)`/g, '$1') // Remove inline code backticks  
    .replace(/\*\*([^*]+)\*\*/g, '$1') // Remove bold markdown
    .replace(/\*([^*]+)\*/g, '$1') // Remove italic markdown
    .replace(/\n{3,}/g, '\n\n') // Collapse multiple newlines
    .replace(/^\s+|\s+$/g, '') // Trim whitespace
    .replace(/\s+/g, ' '); // Normalize spaces
}

function getVSCodeStoragePath(): string {
  const platform = os.platform();
  const homedir = os.homedir();
  
  switch (platform) {
    case 'win32':
      return path.join(homedir, 'AppData', 'Roaming', 'Code', 'User', 'workspaceStorage');
    case 'darwin':
      return path.join(homedir, 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage');
    default: // Linux and others
      return path.join(homedir, '.config', 'Code', 'User', 'workspaceStorage');
  }
}

function normalizePathForCompare(inputPath: string): string {
  const normalized = path.normalize(inputPath).replace(/[\\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function pathsLikelyMatch(pathA: string, pathB: string): boolean {
  const a = normalizePathForCompare(pathA);
  const b = normalizePathForCompare(pathB);

  if (a === b) {
    return true;
  }

  const sep = path.sep;
  return a.startsWith(`${b}${sep}`) || b.startsWith(`${a}${sep}`);
}

function getWorkspaceFolderFromMetadata(workspaceStoragePath: string, workspaceDir: string): string | undefined {
  const workspaceJsonPath = path.join(workspaceStoragePath, workspaceDir, 'workspace.json');
  if (!fs.existsSync(workspaceJsonPath)) {
    return undefined;
  }

  try {
    const workspaceJsonRaw = fs.readFileSync(workspaceJsonPath, 'utf8');
    const workspaceJson = JSON.parse(workspaceJsonRaw);
    const folder = workspaceJson?.folder;

    if (typeof folder === 'string') {
      if (folder.startsWith('file://')) {
        return vscode.Uri.parse(folder).fsPath;
      }
      return folder;
    }

    if (folder && typeof folder === 'object' && typeof folder.path === 'string') {
      return folder.path;
    }
  } catch {
    // Ignore malformed metadata
  }

  return undefined;
}

function collectWorkspaceCandidates(workspaceStoragePath: string): WorkspaceCandidate[] {
  const workspaceDirs = fs.readdirSync(workspaceStoragePath);
  const candidates: WorkspaceCandidate[] = [];

  for (const workspaceDir of workspaceDirs) {
    const chatSessionsPath = path.join(workspaceStoragePath, workspaceDir, 'chatSessions');
    if (!fs.existsSync(chatSessionsPath)) {
      continue;
    }

    const sessionFiles = fs.readdirSync(chatSessionsPath).filter((f: string) => f.endsWith('.json'));
    if (sessionFiles.length === 0) {
      continue;
    }

    let mostRecentTime = 0;
    for (const file of sessionFiles) {
      const stat = fs.statSync(path.join(chatSessionsPath, file));
      if (stat.mtime.getTime() > mostRecentTime) {
        mostRecentTime = stat.mtime.getTime();
      }
    }

    candidates.push({
      workspaceDir,
      chatSessionsPath,
      sessionFiles,
      mostRecentTime,
      workspaceFolderPath: getWorkspaceFolderFromMetadata(workspaceStoragePath, workspaceDir)
    });
  }

  return candidates;
}

async function getCurrentWorkspaceHash(): Promise<{ hash: string | null; diagnostics: string[] }> {
  const diagnostics: string[] = [];
  const folders = vscode.workspace.workspaceFolders;
  
  if (!folders || folders.length === 0) {
    diagnostics.push('No workspace folder is currently open');
    return { hash: null, diagnostics };
  }
  
  const currentWorkspacePaths = folders.map((folder) => folder.uri.fsPath);
  diagnostics.push(`Current workspace folders: ${currentWorkspacePaths.join(', ')}`);
  
  // Find the matching workspace storage directory
  const workspaceStoragePath = getVSCodeStoragePath();
  diagnostics.push(`Checking VS Code storage: ${workspaceStoragePath}`);
  
  if (!fs.existsSync(workspaceStoragePath)) {
    diagnostics.push('VS Code workspace storage directory not found');
    return { hash: null, diagnostics };
  }
  
  const candidates = collectWorkspaceCandidates(workspaceStoragePath);
  diagnostics.push(`Found ${candidates.length} workspace directories with chat session files`);

  if (candidates.length === 0) {
    return { hash: null, diagnostics };
  }

  const exactMatches = candidates.filter((candidate) =>
    candidate.workspaceFolderPath &&
    currentWorkspacePaths.some((workspacePath) => pathsLikelyMatch(candidate.workspaceFolderPath as string, workspacePath))
  );

  if (exactMatches.length > 0) {
    const bestMatch = exactMatches.sort((a, b) => b.mostRecentTime - a.mostRecentTime)[0];
    diagnostics.push(`Matched workspace via workspace.json: ${bestMatch.workspaceDir}`);
    return { hash: bestMatch.workspaceDir, diagnostics };
  }

  const fallbackMatch = candidates.sort((a, b) => b.mostRecentTime - a.mostRecentTime)[0];
  diagnostics.push(`No exact workspace match found, using latest active workspace: ${fallbackMatch.workspaceDir}`);
  return { hash: fallbackMatch.workspaceDir, diagnostics };
}

function getSessionId(chatSession: any, sessionFile: string): string {
  if (typeof chatSession?.sessionId === 'string' && chatSession.sessionId.length > 0) {
    return chatSession.sessionId;
  }
  return sessionFile.replace(/\.json$/i, '');
}

function getSessionCreationDate(chatSession: any): number {
  if (typeof chatSession?.creationDate === 'number') {
    return chatSession.creationDate;
  }
  if (typeof chatSession?.lastMessageDate === 'number') {
    return chatSession.lastMessageDate;
  }
  return Date.now();
}

async function scanChatSessionFiles(allEntries: CopilotEntry[], diagnostics: string[]) {
  // Get the current workspace hash
  const workspaceResult = await getCurrentWorkspaceHash();
  if (!workspaceResult.hash) {
    diagnostics.push(...workspaceResult.diagnostics);
    return;
  }
  
  const currentWorkspaceHash = workspaceResult.hash;
  diagnostics.push(...workspaceResult.diagnostics);
  
  const workspaceStoragePath = getVSCodeStoragePath();
  const workspaceDir = currentWorkspaceHash;
  const chatSessionsPath = path.join(workspaceStoragePath, workspaceDir, 'chatSessions');
  
  diagnostics.push(`Looking for chat sessions in: ${chatSessionsPath}`);
  
  if (fs.existsSync(chatSessionsPath)) {
    const sessionFiles = fs.readdirSync(chatSessionsPath).filter((f: string) => f.endsWith('.json'));
    diagnostics.push(`Found ${sessionFiles.length} JSON session files`);
    
    for (const sessionFile of sessionFiles) {
      try {
        const filePath = path.join(chatSessionsPath, sessionFile);
        const content = await readFile(filePath, 'utf8');
        const chatSession = JSON.parse(content);
        const sessionId = getSessionId(chatSession, sessionFile);
        const sessionDate = new Date(getSessionCreationDate(chatSession)).toLocaleDateString();
        
        if (chatSession.requests && chatSession.requests.length > 0) {
          // Process each request-response pair
          for (let i = 0; i < chatSession.requests.length; i++) {
            const request = chatSession.requests[i];
            
            if (request.message && request.message.text) {
              // Extract user message (clean text only)
              const userMessage = cleanText(request.message.text);
              
              // Extract Copilot response (array of response objects)
              let copilotResponse = 'No response';
              if (request.response && Array.isArray(request.response)) {
                // Concatenate all response parts
                const responseParts: string[] = [];
                for (const responsePart of request.response) {
                  if (responsePart && responsePart.value && typeof responsePart.value === 'string') {
                    responseParts.push(cleanText(responsePart.value));
                  }
                }
                if (responseParts.length > 0) {
                  copilotResponse = responseParts.join(' ').trim();
                }
              }
              
              // Only add if we have meaningful content
              if (userMessage.length > 10 && copilotResponse.length > 10) {
                allEntries.push({
                  key: `conversation-${i + 1}`,
                  content: {
                    session: sessionId.substring(0, 8),
                    date: sessionDate,
                    human: userMessage,
                    copilot: copilotResponse
                  },
                  workspace: currentWorkspaceHash,
                  type: 'conversation'
                });
              }
            }
          }
        }
      } catch (error) {
        diagnostics.push(`Error reading session file ${sessionFile}: ${error}`);
      }
    }
    
    const conversationCount = allEntries.length;
    diagnostics.push(`Processed files and found ${conversationCount} valid conversations`);
  } else {
    diagnostics.push('Chat sessions directory does not exist');
  }
}

export function activate(context: vscode.ExtensionContext) {
  // Status bar button
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = "$(file-code) Export Copilot Chat";
  statusBarItem.command = 'copilot-exporter.exportWorkspaceHistory';
  statusBarItem.tooltip = "Export GitHub Copilot chat history";
  statusBarItem.show();

  const exportCommand = vscode.commands.registerCommand('copilot-exporter.exportWorkspaceHistory', async () => {
    try {
      // Get output directory
      const folders = vscode.workspace.workspaceFolders || [];
      const defaultOut = folders.length ? path.join(folders[0].uri.fsPath, 'copilot_exports') : path.join(os.homedir(), 'copilot_exports');

      const outUri = await vscode.window.showOpenDialog({ 
        canSelectFolders: true, 
        canSelectFiles: false, 
        openLabel: 'Select output folder' 
      });
      
      const outDir = outUri ? outUri[0].fsPath : defaultOut;
      await mkdir(outDir, { recursive: true });

      let allEntries: CopilotEntry[] = [];
      let diagnostics: string[] = [];

      // Scan for actual chat session JSON files (main conversations)
      await scanChatSessionFiles(allEntries, diagnostics);

      // Export to JSON
      if (allEntries.length > 0) {
        const outputFile = path.join(outDir, `copilot_export_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
        await writeFile(outputFile, JSON.stringify(allEntries, null, 2), 'utf8');
        
        const message = `Copilot export complete! ${allEntries.length} entries exported to ${outputFile}`;
        const action = await vscode.window.showInformationMessage(message, 'Open File', 'Open Folder');
        
        if (action === 'Open File') {
          vscode.commands.executeCommand('vscode.open', vscode.Uri.file(outputFile));
        } else if (action === 'Open Folder') {
          vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(outDir));
        }
      } else {
        // Create detailed diagnostic report
        const diagnosticReport = [
          '🔍 **Copilot Export Diagnostics**',
          '',
          '**Search Details:**',
          ...diagnostics.map(d => `• ${d}`),
          '',
          '**Possible Solutions:**',
          '• Make sure you have used GitHub Copilot Chat in this workspace',
          '• Try opening a different workspace where you\'ve used Copilot',
          '• Check if VS Code is storing data in a custom location',
          '• On Windows, data might be in a different AppData folder',
          '• Verify workspace.json mapping if your workspace was moved or renamed'
        ].join('\n');

        // Save diagnostic report
        const diagnosticFile = path.join(outDir, `copilot_export_diagnostics_${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
        await writeFile(diagnosticFile, diagnosticReport, 'utf8');
        
        const action = await vscode.window.showWarningMessage(
          'No Copilot data found. Click "View Details" to see diagnostic information.', 
          'View Details', 
          'Close'
        );
        
        if (action === 'View Details') {
          vscode.commands.executeCommand('vscode.open', vscode.Uri.file(diagnosticFile));
        }
      }

    } catch (error) {
      vscode.window.showErrorMessage('Copilot export failed: ' + String(error));
    }
  });

  context.subscriptions.push(statusBarItem, exportCommand);
}

export function deactivate() {}
