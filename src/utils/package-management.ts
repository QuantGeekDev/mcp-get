import inquirer from 'inquirer';
import { Package } from '../types/index.js';
import { getConfigPath, installMCPServer, readConfig, writeConfig } from './config.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { packageHelpers } from '../helpers/index.js';
import { checkUVInstalled, promptForUVInstall } from './runtime-utils.js';
import path from 'path';
import fs from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

declare function fetch(url: string, init?: any): Promise<{ ok: boolean; statusText: string }>;

const execAsync = promisify(exec);

interface MCPPreferences {
  allowAnalytics?: boolean;
}

function getPreferencesPath(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'mcp-get', 'preferences.json');
  }
  
  // Unix-like systems (Linux, macOS)
  const homeDir = os.homedir();
  return path.join(homeDir, '.mcp-get', 'preferences.json');
}

function readPreferences(): MCPPreferences {
  const prefsPath = getPreferencesPath();
  if (!fs.existsSync(prefsPath)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
  } catch (error) {
    return {};
  }
}

function writePreferences(prefs: MCPPreferences): void {
  const prefsPath = getPreferencesPath();
  const prefsDir = path.dirname(prefsPath);
  
  if (!fs.existsSync(prefsDir)) {
    fs.mkdirSync(prefsDir, { recursive: true });
  }
  
  fs.writeFileSync(prefsPath, JSON.stringify(prefs, null, 2));
}

async function checkAnalyticsConsent(): Promise<boolean> {
  const prefs = readPreferences();
  
  if (typeof prefs.allowAnalytics === 'boolean') {
    return prefs.allowAnalytics;
  }

  const { allowAnalytics } = await inquirer.prompt<{ allowAnalytics: boolean }>([{
    type: 'confirm',
    name: 'allowAnalytics',
    message: 'Would you like to help improve mcp-get by sharing anonymous installation analytics?',
    default: true
  }]);

  writePreferences({ ...prefs, allowAnalytics });
  return allowAnalytics;
}

async function trackInstallation(packageName: string): Promise<void> {
  try {
    const response = await fetch(`https://mcp-get.com/api/packages/${packageName}/install`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    });
    if (!response.ok) {
      throw new Error(`Failed to track installation: ${response.statusText}`);
    }
  } catch (error) {
    console.warn('Failed to track package installation');
  }
}

async function promptForEnvVars(packageName: string): Promise<Record<string, string> | undefined> {
  const helpers = packageHelpers[packageName];
  if (!helpers?.requiredEnvVars) {
    return undefined;
  }

  // Check if all required variables exist in environment
  const existingEnvVars: Record<string, string> = {};
  let hasAllRequired = true;
  
  for (const [key, value] of Object.entries(helpers.requiredEnvVars)) {
    const existingValue = process.env[key];
    if (existingValue) {
      existingEnvVars[key] = existingValue;
    } else if (value.required) {
      hasAllRequired = false;
    }
  }

  if (hasAllRequired && Object.keys(existingEnvVars).length > 0) {
    const { useAutoSetup } = await inquirer.prompt<{ useAutoSetup: boolean }>([{
      type: 'confirm',
      name: 'useAutoSetup',
      message: 'Found all required environment variables. Would you like to use them automatically?',
      default: true
    }]);

    if (useAutoSetup) {
      return existingEnvVars;
    }
  }

  const { configureEnv } = await inquirer.prompt<{ configureEnv: boolean }>([{
    type: 'confirm',
    name: 'configureEnv',
    message: hasAllRequired 
      ? 'Would you like to manually configure environment variables for this package?'
      : 'Some required environment variables are missing. Would you like to configure them now?',
    default: !hasAllRequired
  }]);

  if (!configureEnv) {
    if (!hasAllRequired) {
      const configPath = getConfigPath();
      console.log('\nNote: Some required environment variables are not configured.');
      console.log(`You can set them later by editing the config file at:`);
      console.log(configPath);
    }
    return undefined;
  }

  const envVars: Record<string, string> = {};
  
  for (const [key, value] of Object.entries(helpers.requiredEnvVars)) {
    const existingEnvVar = process.env[key];
    
    if (existingEnvVar) {
      const { reuseExisting } = await inquirer.prompt<{ reuseExisting: boolean }>([{
        type: 'confirm',
        name: 'reuseExisting',
        message: `Found ${key} in your environment variables. Would you like to use it?`,
        default: true
      }]);

      if (reuseExisting) {
        envVars[key] = existingEnvVar;
        continue;
      }
    }

    const { envValue } = await inquirer.prompt([{
      type: 'input',
      name: 'envValue',
      message: `Please enter ${value.description}:`,
      default: value.required ? undefined : null,
      validate: (input: string) => {
        if (value.required && !input) {
          return `${key} is required`;
        }
        return true;
      }
    }]);

    if (envValue !== null) {
      envVars[key] = envValue;
    }
  }

  if (Object.keys(envVars).length === 0) {
    const configPath = getConfigPath();
    console.log('\nNo environment variables were configured.');
    console.log(`You can set them later by editing the config file at:`);
    console.log(configPath);
    return undefined;
  }

  return envVars;
}

async function isClaudeRunning(): Promise<boolean> {
  try {
    const platform = process.platform;
    if (platform === 'win32') {
      const { stdout } = await execAsync('tasklist /FI "IMAGENAME eq Claude.exe" /NH');
      return stdout.includes('Claude.exe');
    } else if (platform === 'darwin') {
      const { stdout } = await execAsync('pgrep -x "Claude"');
      return !!stdout.trim();
    } else if (platform === 'linux') {
      const { stdout } = await execAsync('pgrep -f "claude"');
      return !!stdout.trim();
    }
    return false;
  } catch (error) {
    // If the command fails, assume Claude is not running
    return false;
  }
}

async function promptForRestart(): Promise<boolean> {
  // Check if Claude is running first
  const claudeRunning = await isClaudeRunning();
  if (!claudeRunning) {
    return false;
  }

  const { shouldRestart } = await inquirer.prompt<{ shouldRestart: boolean }>([
    {
      type: 'confirm',
      name: 'shouldRestart',
      message: 'Would you like to restart the Claude desktop app to apply changes?',
      default: true
    }
  ]);
  
  if (shouldRestart) {
    console.log('Restarting Claude desktop app...');
    try {
      const platform = process.platform;
      if (platform === 'win32') {
        await execAsync('taskkill /F /IM "Claude.exe" && start "" "Claude.exe"');
      } else if (platform === 'darwin') {
        await execAsync('killall "Claude" && open -a "Claude"');
      } else if (platform === 'linux') {
        await execAsync('pkill -f "claude" && claude');
      }

      // Wait a moment for the app to close before reopening
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Reopen the app
      if (platform === 'win32') {
        await execAsync('start "" "Claude.exe"');
      } else if (platform === 'darwin') {
        await execAsync('open -a "Claude"');
      } else if (platform === 'linux') {
        await execAsync('claude');
      }

      console.log('Claude desktop app has been restarted.');
    } catch (error) {
      console.error('Failed to restart Claude desktop app:', error);
    }
  }
  
  return shouldRestart;
}

export async function installPackage(pkg: Package): Promise<void> {
  try {
    // Check for UV if it's a Python package
    if (pkg.runtime === 'python') {
      const hasUV = await checkUVInstalled();
      if (!hasUV) {
        const installed = await promptForUVInstall(inquirer);
        if (!installed) {
          console.log('Proceeding with installation, but uvx commands may fail...');
        }
      }
    }

    const envVars = await promptForEnvVars(pkg.name);
    
    await installMCPServer(pkg.name, envVars, pkg.runtime);
    console.log('Updated Claude desktop configuration');

    // Check analytics consent and track if allowed
    const analyticsAllowed = await checkAnalyticsConsent();
    if (analyticsAllowed) {
      await trackInstallation(pkg.name);
    }

    await promptForRestart();
  } catch (error) {
    console.error('Failed to install package:', error);
    throw error;
  }
}

export async function uninstallPackage(packageName: string): Promise<void> {
  try {
    const config = readConfig();
    // Sanitize package name the same way as installation
    const serverName = packageName.replace(/\//g, '-');
    
    if (!config.mcpServers || !config.mcpServers[serverName]) {
      console.log(`Package ${packageName} is not installed.`);
      return;
    }
    
    delete config.mcpServers[serverName];
    writeConfig(config);
    console.log(`\nUninstalled ${packageName}`);
    await promptForRestart();
  } catch (error) {
    console.error('Failed to uninstall package:', error);
    throw error;
  }
}

export function isPackageInstalled(packageName: string): boolean {
  const config = readConfig();
  return packageName in (config.mcpServers || {});
}

export function getPackageDetails(packageName: string): Package {
  // Read package list from JSON file
  const packageListPath = path.join(dirname(fileURLToPath(import.meta.url)), '../../packages/package-list.json');
  const packages: Package[] = JSON.parse(fs.readFileSync(packageListPath, 'utf8'));
  
  // Find the package
  const pkg = packages.find(p => p.name === packageName);
  if (!pkg) {
    throw new Error(`Package ${packageName} not found`);
  }

  return {
    ...pkg,
    isInstalled: isPackageInstalled(packageName)
  };
} 
