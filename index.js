import blessed from "blessed";
import chalk from "chalk";
import figlet from "figlet";
import { ethers } from "ethers";
import fs from "fs";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";

const KALEIDO_RPC_URL = "https://11124.rpc.thirdweb.com/1f9e649fdf16709afd04bb52b54d1964";
const KALEIDO_CHAIN_ID = 11124;
const KLD_TOKEN_ADDRESS = "0x0c61dbCF1e8DdFF0E237a256257260fDF6934505";
const USDC_TOKEN_ADDRESS = "0x572f4901f03055ffC1D936a60Ccc3CbF13911BE3";
const DEPOSIT_ROUTER_ADDRESS = "0x2aC60481a9EA2e67D80CdfBF587c63c88A5874ac";
const STAKE_ROUTER_ADDRESS = "0xb6fb7fd04eCF2723f8a5659134a145Bd7fE68748";
const FAUCET_ROUTER_ADDRESS = "0xC99eddf1f7C9250728A47978732928aE158396E7";

const CONFIG_FILE = "config.json";
const isDebug = false;

const tokenAbi = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)"
];

const faucetAbi = [
  "function lastClaimed(address) view returns (uint256)",
  "function COOLDOWN() view returns (uint256)",
  "function hasClaimedBefore(address) view returns (bool)"
];

let walletInfo = {
  address: "N/A",
  balanceETH: "0.0000",
  balanceUSDC: "0.00",
  balanceKLD: "0.0000",
  activeAccount: "N/A"
};
let transactionLogs = [];
let isActivityRunning = false;
let isScheduled = false;
let isCycleRunning = false;
let shouldStop = false;
let dailyActivityInterval = null;
let privateKeys = [];
let proxies = [];
let selectedWalletIndex = 0;
let loadingSpinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const borderBlinkColors = ["cyan", "blue", "magenta", "red", "yellow", "green"];
let borderBlinkIndex = 0;
let blinkCounter = 0;
let spinnerIndex = 0;
let nonceTracker = {};
let hasLoggedSleepInterrupt = false;
let isHeaderRendered = false;
let activeProcesses = 0;

let dailyActivityConfig = {
  depositRepetitions: 1,
  minAmountDeposit: 0.1,
  maxAmountDeposit: 0.5,
  lendRepetitions: 1,
  minAmountLend: 0.1,
  maxAmountLend: 0.5,
  stakeRepetitions: 1,
  minAmountStake: 10,
  maxAmountStake: 50,
  actionDelay: 10000,
  accountDelay: 10000,
  cycleIntervalHours: 1
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, "utf8");
      const config = JSON.parse(data);
      dailyActivityConfig.depositRepetitions = Number(config.depositRepetitions) || 1;
      dailyActivityConfig.minAmountDeposit = Number(config.minAmountDeposit) || 0.1;
      dailyActivityConfig.maxAmountDeposit = Number(config.maxAmountDeposit) || 0.5;
      dailyActivityConfig.lendRepetitions = Number(config.lendRepetitions) || 1;
      dailyActivityConfig.minAmountLend = Number(config.minAmountLend) || 0.1;
      dailyActivityConfig.maxAmountLend = Number(config.maxAmountLend) || 0.5;
      dailyActivityConfig.stakeRepetitions = Number(config.stakeRepetitions) || 1;
      dailyActivityConfig.minAmountStake = Number(config.minAmountStake) || 10;
      dailyActivityConfig.maxAmountStake = Number(config.maxAmountStake) || 50;
      dailyActivityConfig.actionDelay = Number(config.actionDelay) || 10000;
      dailyActivityConfig.accountDelay = Number(config.accountDelay) || 10000;
      dailyActivityConfig.cycleIntervalHours = Number(config.cycleIntervalHours) || 1;
    } else {
      addLog("No config file found, using default settings.", "info");
    }
  } catch (error) {
    addLog(`Failed to load config: ${error.message}`, "error");
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(dailyActivityConfig, null, 2));
    addLog("Configuration saved successfully.", "success");
  } catch (error) {
    addLog(`Failed to save config: ${error.message}`, "error");
  }
}

async function makeJsonRpcCall(method, params, rpcUrl) {
  try {
    const id = uuidv4();
    const proxyUrl = proxies[selectedWalletIndex % proxies.length] || null;
    const agent = createAgent(proxyUrl);
    const response = await axios.post(rpcUrl, {
      jsonrpc: "2.0",
      id,
      method,
      params
    }, {
      headers: { "Content-Type": "application/json" },
      httpsAgent: agent
    });
    const data = response.data;
    if (data.error) throw new Error(`RPC Error: ${data.error.message} (code: ${data.error.code})`);
    if (!data.result && data.result !== "") throw new Error("No result in RPC response");
    return data.result;
  } catch (error) {
    addLog(`JSON-RPC call failed (${method}): ${error.message}`, "error");
    throw error;
  }
}

process.on("unhandledRejection", (reason) => {
  addLog(`Unhandled Rejection: ${reason.message || reason}`, "error");
});

process.on("uncaughtException", (error) => {
  addLog(`Uncaught Exception: ${error.message}\n${error.stack}`, "error");
  process.exit(1);
});

function getShortAddress(address) {
  return address ? address.slice(0, 6) + "..." + address.slice(-4) : "N/A";
}

function addLog(message, type = "info") {
  if (type === "debug" && !isDebug) return;
  const timestamp = new Date().toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" });
  let coloredMessage;
  switch (type) {
    case "error": coloredMessage = chalk.redBright(message); break;
    case "success": coloredMessage = chalk.greenBright(message); break;
    case "start": coloredMessage = chalk.magentaBright(message); break;
    case "wait": coloredMessage = chalk.yellowBright(message); break;
    case "info": coloredMessage = chalk.whiteBright(message); break;
    case "delay": coloredMessage = chalk.cyanBright(message); break;
    case "debug": coloredMessage = chalk.blueBright(message); break;
    default: coloredMessage = chalk.white(message);
  }
  const logMessage = `[${timestamp}] ${coloredMessage}`;
  transactionLogs.push(logMessage);
  updateLogs();
}

function getShortHash(hash) {
  return hash.slice(0, 6) + "..." + hash.slice(-4);
}

function clearTransactionLogs() {
  transactionLogs = [];
  logBox.setContent('');
  logBox.scrollTo(0);
  addLog("Transaction logs cleared.", "success");
}

function loadPrivateKeys() {
  try {
    const data = fs.readFileSync("pk.txt", "utf8");
    privateKeys = data.split("\n").map(key => key.trim()).filter(key => key.match(/^(0x)?[0-9a-fA-F]{64}$/));
    if (privateKeys.length === 0) throw new Error("No valid private keys in pk.txt");
    addLog(`Loaded ${privateKeys.length} private keys from pk.txt`, "success");
  } catch (error) {
    addLog(`Failed to load private keys: ${error.message}`, "error");
    privateKeys = [];
  }
}

function loadProxies() {
  try {
    if (fs.existsSync("proxy.txt")) {
      const data = fs.readFileSync("proxy.txt", "utf8");
      proxies = data.split("\n").map(proxy => proxy.trim()).filter(proxy => proxy);
      if (proxies.length === 0) throw new Error("No proxy found in proxy.txt");
      addLog(`Loaded ${proxies.length} proxies from proxy.txt`, "success");
    } else {
      addLog("No proxy.txt found, running without proxy.", "info");
    }
  } catch (error) {
    addLog(`Failed to load proxy: ${error.message}`, "info");
    proxies = [];
  }
}

function createAgent(proxyUrl) {
  if (!proxyUrl) return null;
  if (proxyUrl.startsWith("socks")) return new SocksProxyAgent(proxyUrl);
  return new HttpsProxyAgent(proxyUrl);
}

function getProviderWithProxy(proxyUrl, rpcUrl, chainId) {
  const agent = createAgent(proxyUrl);
  const fetchOptions = agent ? { agent } : {};
  const provider = new ethers.JsonRpcProvider(rpcUrl, { chainId, name: "Kaleido" }, { fetchOptions });
  return provider;
}

async function sleep(ms) {
  if (shouldStop) {
    if (!hasLoggedSleepInterrupt) {
      addLog("Process stopped successfully.", "info");
      hasLoggedSleepInterrupt = true;
    }
    return;
  }
  activeProcesses++;
  try {
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, ms);
      const checkStop = setInterval(() => {
        if (shouldStop) {
          clearTimeout(timeout);
          clearInterval(checkStop);
          if (!hasLoggedSleepInterrupt) {
            addLog("Process interrupted.", "info");
            hasLoggedSleepInterrupt = true;
          }
          resolve();
        }
      }, 100);
    });
  } finally {
    activeProcesses = Math.max(0, activeProcesses - 1);
  }
}

async function updateWalletData() {
  const walletDataPromises = privateKeys.map(async (privateKey, i) => {
    try {
      const proxyUrl = proxies[i % proxies.length] || null;
      const provider = getProviderWithProxy(proxyUrl, KALEIDO_RPC_URL, KALEIDO_CHAIN_ID);
      const wallet = new ethers.Wallet(privateKey, provider);

      const ethBalance = await provider.getBalance(wallet.address);
      const formattedETH = Number(ethers.formatUnits(ethBalance, 18)).toFixed(4);

      const usdcContract = new ethers.Contract(USDC_TOKEN_ADDRESS, tokenAbi, provider);
      const usdcBalance = await usdcContract.balanceOf(wallet.address);
      const formattedUSDC = Number(ethers.formatUnits (usdcBalance, 6)).toFixed(2);

      const kldContract = new ethers.Contract(KLD_TOKEN_ADDRESS, tokenAbi, provider);
      const kldBalance = await kldContract.balanceOf(wallet.address);
      const formattedKLD = Number(ethers.formatUnits(kldBalance, 18)).toFixed(4);

      const formattedEntry = `${i === selectedWalletIndex ? "→ " : "  "}${chalk.bold.magentaBright(getShortAddress(wallet.address))}   ${chalk.bold.cyanBright(formattedETH.padEnd(8))}   ${chalk.bold.greenBright(formattedUSDC.padEnd(8))}   ${chalk.bold.yellowBright(formattedKLD.padEnd(8))}`;

      if (i === selectedWalletIndex) {
        walletInfo.address = wallet.address;
        walletInfo.activeAccount = `Account ${i + 1}`;
        walletInfo.balanceETH = formattedETH;
        walletInfo.balanceUSDC = formattedUSDC;
        walletInfo.balanceKLD = formattedKLD;
      }
      return formattedEntry;
    } catch (error) {
      addLog(`Failed to fetch wallet data for account #${i + 1}: ${error.message}`, "error");
      return `${i === selectedWalletIndex ? "→ " : "  "}N/A 0.0000 0.00 0.0000`;
    }
  });
  try {
    const walletData = await Promise.all(walletDataPromises);
    addLog("Wallet data updated.", "success");
    return walletData;
  } catch (error) {
    addLog(`Wallet data update failed: ${error.message}`, "error");
    return [];
  }
}
  async function getNextNonce(provider, walletAddress) {
    if (shouldStop) {
      addLog("Nonce fetch stopped due to stop request.", "info");
      throw new Error("Process stopped");
    }
    if (!walletAddress || !ethers.isAddress(walletAddress)) {
      addLog(`Invalid wallet address: ${walletAddress}`, "error");
      throw new Error("Invalid wallet address");
    }
    try {
      const pendingNonce = await provider.getTransactionCount(walletAddress, "pending");
      const lastUsedNonce = nonceTracker[walletAddress] || pendingNonce - 1;
      const nextNonce = Math.max(pendingNonce, lastUsedNonce + 1);
      nonceTracker[walletAddress] = nextNonce;
      addLog(`Debug: Fetched nonce ${nextNonce} for ${getShortAddress(walletAddress)}`, "debug");
      return nextNonce;
    } catch (error) {
      addLog(`Failed to fetch nonce for ${getShortAddress(walletAddress)}: ${error.message}`, "error");
      throw error;
    }
  }

  async function depositCollateral(wallet, amount) {
    try {
      addLog(`Debug: Starting deposit collateral of ${amount} USDC for ${getShortAddress(wallet.address)}`, "debug");
      const amountWei = ethers.parseUnits(amount.toString(), 6);
      const usdcContract = new ethers.Contract(USDC_TOKEN_ADDRESS, tokenAbi, wallet);
      
      addLog(`Debug: Checking USDC balance for ${getShortAddress(wallet.address)}`, "debug");
      const usdcBalance = await usdcContract.balanceOf(wallet.address);
      const formattedBalance = ethers.formatUnits(usdcBalance, 6);
      if (usdcBalance < amountWei) {
        throw new Error(`Insufficient USDC balance: ${formattedBalance} USDC available`);
      }
      addLog(`USDC Balance: ${formattedBalance} USDC`, "debug");

      addLog(`Debug: Checking allowance for ${DEPOSIT_ROUTER_ADDRESS}`, "debug");
      const allowance = await usdcContract.allowance(wallet.address, DEPOSIT_ROUTER_ADDRESS);
      addLog(`Debug: Allowance: ${ethers.formatUnits(allowance, 6)} USDC`, "debug");
      if (allowance < amountWei) {
        addLog(`Approving ${amount} USDC for deposit`, "info");
        const approveTx = await usdcContract.approve(DEPOSIT_ROUTER_ADDRESS, amountWei);
        await approveTx.wait();
        addLog(`Approval USDC successful, Hash: ${getShortHash(approveTx.hash)}`, "success");
      }

      const data = "0xa5d5db0c" +
        ethers.zeroPadValue(USDC_TOKEN_ADDRESS, 32).slice(2) +
        ethers.zeroPadValue(ethers.toBeHex(amountWei), 32).slice(2);

      const tx = {
        to: DEPOSIT_ROUTER_ADDRESS,
        data,
        gasLimit: 691650,
        chainId: KALEIDO_CHAIN_ID,
        nonce: await getNextNonce(wallet.provider, wallet.address)
      };
      addLog(`Debug: Sending deposit transaction: ${JSON.stringify(tx)}`, "debug");
      const sentTx = await wallet.sendTransaction(tx);
      addLog(`Deposit Transaction Sent: ${getShortHash(sentTx.hash)}`, "start");
      const receipt = await sentTx.wait();
      if (receipt.status === 0) {
        addLog(`Deposit Transaction reverted: ${JSON.stringify(receipt)}`, "error");
        throw new Error("Transaction reverted");
      }
      addLog(`Deposit ${amount} USDC Successfully, Hash: ${getShortHash(sentTx.hash)}`, "success");
    } catch (error) {
      addLog(`Deposit Collateral Failed: ${error.message}`, "error");
      throw error;
    }
  }

  async function lend(wallet, amount) {
    try {
      addLog(`Debug: Starting lend of ${amount} USDC for ${getShortAddress(wallet.address)}`, "debug");
      const amountWei = ethers.parseUnits(amount.toString(), 6);
      const usdcContract = new ethers.Contract(USDC_TOKEN_ADDRESS, tokenAbi, wallet);

      addLog(`Debug: Checking USDC balance for ${getShortAddress(wallet.address)}`, "debug");
      const usdcBalance = await usdcContract.balanceOf(wallet.address);
      const formattedBalance = ethers.formatUnits(usdcBalance, 6);
      if (usdcBalance < amountWei) {
        throw new Error(`Insufficient USDC balance: ${formattedBalance} USDC available`);
      }
      addLog(`USDC Balance: ${formattedBalance} USDC`, "wait");

      addLog(`Debug: Checking allowance for ${DEPOSIT_ROUTER_ADDRESS}`, "debug");
      const allowance = await usdcContract.allowance(wallet.address, DEPOSIT_ROUTER_ADDRESS);
      addLog(`Debug: Allowance: ${ethers.formatUnits(allowance, 6)} USDC`, "debug");
      if (allowance < amountWei) {
        addLog(`Approving ${amount} USDC for lend`, "info");
        const approveTx = await usdcContract.approve(DEPOSIT_ROUTER_ADDRESS, amountWei);
        await approveTx.wait();
        addLog(`Approval USDC successful, Hash: ${getShortHash(approveTx.hash)}`, "success");
      }

      const now = new Date();
      const daysToAdd = Math.floor(Math.random() * 2) + 3;
      const expirationDate = new Date(now.setDate(now.getDate() + daysToAdd));
      const expirationTimestamp = Math.floor(expirationDate.getTime() / 1000);

      const data = "0x5068a88a" +
        ethers.zeroPadValue(ethers.toBeHex(amountWei), 32).slice(2) +
        ethers.zeroPadValue(ethers.toBeHex(0), 32).slice(2) +
        ethers.zeroPadValue(ethers.toBeHex(amountWei), 32).slice(2) +
        ethers.zeroPadValue(ethers.toBeHex(expirationTimestamp), 32).slice(2) +
        ethers.zeroPadValue(ethers.toBeHex(500), 32).slice(2) +
        ethers.zeroPadValue(USDC_TOKEN_ADDRESS, 32).slice(2);

      const tx = {
        to: DEPOSIT_ROUTER_ADDRESS,
        data,
        gasLimit: 977416,
        chainId: KALEIDO_CHAIN_ID,
        nonce: await getNextNonce(wallet.provider, wallet.address)
      };
      addLog(`Debug: Sending lend transaction: ${JSON.stringify(tx)}`, "debug");
      const sentTx = await wallet.sendTransaction(tx);
      addLog(`Lend Transaction Sent: ${getShortHash(sentTx.hash)}`, "start");
      const receipt = await sentTx.wait();
      if (receipt.status === 0) {
        addLog(`Lend transaction reverted: ${JSON.stringify(receipt)}`, "error");
        throw new Error("Transaction reverted");
      }
      addLog(`Lend ${amount} USDC Successfully, Hash: ${getShortHash(sentTx.hash)}`, "success");
    } catch (error) {
      addLog(`Lend Failed: ${error.message}`, "error");
      throw error;
    }
  }

  async function stake(wallet, amount) {
    try {
      addLog(`Debug: Starting stake of ${amount} KLD for ${getShortAddress(wallet.address)}`, "debug");
      const amountWei = ethers.parseUnits(amount.toString(), 18);
      const kldContract = new ethers.Contract(KLD_TOKEN_ADDRESS, tokenAbi, wallet);

      addLog(`Debug: Checking KLD balance for ${getShortAddress(wallet.address)}`, "debug");
      const kldBalance = await kldContract.balanceOf(wallet.address);
      const formattedBalance = ethers.formatUnits(kldBalance, 18);
      if (kldBalance < amountWei) {
        throw new Error(`Insufficient KLD balance: ${formattedBalance} KLD available`);
      }
      addLog(`KLD Balance: ${formattedBalance} KLD`, "debug");

      addLog(`Debug: Checking allowance for ${STAKE_ROUTER_ADDRESS}`, "debug");
      const allowance = await kldContract.allowance(wallet.address, STAKE_ROUTER_ADDRESS);
      addLog(`Debug: Allowance: ${ethers.formatUnits(allowance, 18)} KLD`, "debug");
      if (allowance < amountWei) {
        addLog(`Approving ${amount} KLD for stake`, "info");
        const approveTx = await kldContract.approve(STAKE_ROUTER_ADDRESS, amountWei);
        await approveTx.wait();
        addLog(`Approval KLD successful, Hash: ${getShortHash(approveTx.hash)}`, "success");
      }

      const referralAddress = "0x3fb832980638036e81231931cbd48f95a7746d41";
      const data = "0x8340f549" +
        ethers.zeroPadValue(KLD_TOKEN_ADDRESS, 32).slice(2) +
        ethers.zeroPadValue(referralAddress, 32).slice(2) +
        ethers.zeroPadValue(ethers.toBeHex(amountWei), 32).slice(2);

      const tx = {
        to: STAKE_ROUTER_ADDRESS,
        data,
        gasLimit: 738930,
        chainId: KALEIDO_CHAIN_ID,
        nonce: await getNextNonce(wallet.provider, wallet.address)
      };
      addLog(`Debug: Sending stake transaction: ${JSON.stringify(tx)}`, "debug");
      const sentTx = await wallet.sendTransaction(tx);
      addLog(`Stake Transaction sent: ${getShortHash(sentTx.hash)}`, "start");
      const receipt = await sentTx.wait();
      if (receipt.status === 0) {
        addLog(`Stake transaction reverted: ${JSON.stringify(receipt)}`, "error");
        throw new Error("Transaction reverted");
      }
      addLog(`Stake ${amount} KLD Successfully, Hash: ${getShortHash(sentTx.hash)}`, "success");
    } catch (error) {
      addLog(`Stake Failed: ${error.message}`, "error");
      throw error;
    }
  }

  function formatTime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = seconds % 60;
    let timeString = "";
    if (hours > 0) timeString += `${hours} hour${hours > 1 ? "s" : ""} `;
    if (minutes > 0 || hours > 0) timeString += `${minutes} minute${minutes > 1 ? "s" : ""} `;
    timeString += `${remainingSeconds} second${remainingSeconds > 1 ? "s" : ""}`;
    return timeString.trim();
  }

  async function claimFaucet(wallet) {
    const maxRetries = 3;
    const retryDelay = 10000;
    const gasLimit = 2100000;
    const claimDelay = 10000;

    try {
      addLog(`Starting Claiming Faucet USDC & KLD`, "debug");

      const faucetContract = new ethers.Contract(FAUCET_ROUTER_ADDRESS, faucetAbi, wallet);
      addLog(`Checking USDC Faucet Eligibility For ${getShortAddress(wallet.address)}`, "start");
      let lastClaimedUSDC = await faucetContract.lastClaimed(wallet.address);
      lastClaimedUSDC = Number(lastClaimedUSDC);
      const cooldown = Number(await faucetContract.COOLDOWN());
      const currentTime = Math.floor(Date.now() / 1000);
      let usdcEligible = lastClaimedUSDC === 0 || (currentTime - lastClaimedUSDC) >= cooldown;
      let usdcSuccess = false;
      if (usdcEligible) {
        addLog(`Claiming USDC Faucet For ${getShortAddress(wallet.address)}`, "info");
        for (let attempt = 1; attempt <= maxRetries && !usdcSuccess && !shouldStop; attempt++) {
          try {
            const usdcTx = {
              to: FAUCET_ROUTER_ADDRESS,
              data: "0x4451d89f",
              gasLimit,
              chainId: KALEIDO_CHAIN_ID,
              nonce: await getNextNonce(wallet.provider, wallet.address)
            };
            addLog(`Debug: Attempt ${attempt} - Sending USDC faucet claim transaction: ${JSON.stringify(usdcTx)}`, "debug");
            const sentUsdcTx = await wallet.sendTransaction(usdcTx);
            addLog(`Claim Faucet USDC Transaction Sent: ${getShortHash(sentUsdcTx.hash)}`, "info");
            const usdcReceipt = await sentUsdcTx.wait();
            if (usdcReceipt.status === 0) {
              addLog(`Claim Faucet USDC Failed Transaction reverted: ${JSON.stringify(usdcReceipt)}`, "error");
              throw new Error("Claim Faucet USDC Transaction reverted");
            }
            addLog(`Claim Faucet USDC Successfully, Hash: ${getShortHash(sentUsdcTx.hash)}`, "success");
            usdcSuccess = true;
          } catch (error) {
            let errorMessage = error.message;
            if (error.reason) {
              errorMessage += ` (Reason: ${error.reason})`;
            } else if (error.data) {
              errorMessage += ` (Data: ${error.data})`;
            }
            addLog(`Attempt ${attempt} - USDC faucet claim failed for ${getShortAddress(wallet.address)}: ${errorMessage}`, "error");
            if (attempt < maxRetries && !shouldStop) {
              addLog(`Retrying USDC faucet claim in ${retryDelay / 1000} seconds...`, "delay");
              await sleep(retryDelay);
            } else if (!usdcSuccess) {
              addLog(`USDC faucet claim failed after ${maxRetries} attempts`, "error");
            }
          }
        }
      } else {
        addLog(`This Wallet Already Claim Faucet USDC ${getShortAddress(wallet.address)}. Next Claim: ${formatTime(cooldown - (currentTime - lastClaimedUSDC))}`, "wait");
      }

      if (!shouldStop && usdcSuccess) {
        addLog(`Waiting 10 seconds before KLD faucet claim...`, "delay");
        await sleep(claimDelay);
      }

      if (!shouldStop) {
        addLog(`Checking KLD Faucet Eligibility for ${getShortAddress(wallet.address)}`, "start");
        let lastClaimedKLD;
        try {
          const lastClaimedKLDCall = await wallet.provider.call({
            to: FAUCET_ROUTER_ADDRESS,
            data: "0xafa4d631" + ethers.zeroPadValue(wallet.address, 32).slice(2)
          });
          lastClaimedKLD = Number(ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], lastClaimedKLDCall)[0]);
        } catch (error) {
          addLog(`Failed to check KLD last claimed time for ${getShortAddress(wallet.address)}: ${error.message}`, "error");
          lastClaimedKLD = 0;
        }
        let kldEligible = lastClaimedKLD === 0 || (currentTime - lastClaimedKLD) >= cooldown;
        if (!kldEligible) {
          addLog(`This Wallet Already Claim Faucet KLD ${getShortAddress(wallet.address)}. Next Claim: ${formatTime(cooldown - (currentTime - lastClaimedKLD))}`, "wait");
        } else {
          addLog(`Claiming Faucet KLD for ${getShortAddress(wallet.address)}`, "info");
          let kldSuccess = false;
          for (let attempt = 1; attempt <= maxRetries && !kldSuccess && !shouldStop; attempt++) {
            try {
              const kldTx = {
                to: FAUCET_ROUTER_ADDRESS,
                data: "0x45d3b1f7",
                gasLimit,
                chainId: KALEIDO_CHAIN_ID,
                nonce: await getNextNonce(wallet.provider, wallet.address)
              };
              addLog(`Debug: Attempt ${attempt} - Sending KLD faucet claim transaction: ${JSON.stringify(kldTx)}`, "debug");
              const sentKldTx = await wallet.sendTransaction(kldTx);
              addLog(`Claiming Faucet KLD Transaction sent: ${getShortHash(sentKldTx.hash)}`, "info");
              const kldReceipt = await sentKldTx.wait();
              if (kldReceipt.status === 0) {
                addLog(`Claiming Faucet KLD Transaction reverted: ${JSON.stringify(kldReceipt)}`, "error");
                throw new Error("Claiming Faucet KLD Transaction reverted");
              }
              addLog(`Claiming Faucet KLD Successfully, Hash: ${getShortHash(sentKldTx.hash)}`, "success");
              kldSuccess = true;
            } catch (error) {
              let errorMessage = error.message;
              if (error.reason) {
                errorMessage += ` (Reason: ${error.reason})`;
              } else if (error.data) {
                errorMessage += ` (Data: ${error.data})`;
              }
              addLog(`Attempt ${attempt} - KLD faucet claim failed for ${getShortAddress(wallet.address)}: ${errorMessage}`, "error");
              if (attempt < maxRetries && !shouldStop) {
                addLog(`Retrying KLD faucet claim in ${retryDelay / 1000} seconds...`, "delay");
                await sleep(retryDelay);
              } else if (!kldSuccess) {
                addLog(`KLD faucet claim failed after ${maxRetries} attempts`, "error");
              }
            }
          }
        }
      }
    } catch (error) {
      let errorMessage = error.message;
      if (error.reason) {
        errorMessage += ` (Reason: ${error.reason})`;
      } else if (error.data) {
        errorMessage += ` (Data: ${error.data})`;
      }
      addLog(`Faucet claim process failed for ${getShortAddress(wallet.address)}: ${errorMessage}`, "error");
    }
  }

  async function runDailyActivity() {
    if (privateKeys.length === 0) {
      addLog("No valid private keys found.", "error");
      return;
    }
    addLog(`Starting daily activity. Deposit: ${dailyActivityConfig.depositRepetitions}x, Lend: ${dailyActivityConfig.lendRepetitions}x, Stake: ${dailyActivityConfig.stakeRepetitions}x, Claim Faucet: 1x`, "info");
    isActivityRunning = true;
    isCycleRunning = true;
    shouldStop = false;
    hasLoggedSleepInterrupt = false;
    activeProcesses = Math.max(0, activeProcesses);
    updateMenu();
    try {
      for (let accountIndex = 0; accountIndex < privateKeys.length && !shouldStop; accountIndex++) {
        addLog(`Starting processing for account ${accountIndex + 1}`, "info");
        selectedWalletIndex = accountIndex;
        const proxyUrl = proxies[accountIndex % proxies.length] || null;
        addLog(`Account ${accountIndex + 1}: Using Proxy ${proxyUrl || "none"}`, "info");
        const provider = getProviderWithProxy(proxyUrl, KALEIDO_RPC_URL, KALEIDO_CHAIN_ID);
        const wallet = new ethers.Wallet(privateKeys[accountIndex], provider);
        if (!ethers.isAddress(wallet.address)) {
          addLog(`Invalid wallet address for account ${accountIndex + 1}: ${wallet.address}`, "error");
          continue;
        }
        addLog(`Processing account ${accountIndex + 1}: ${getShortAddress(wallet.address)}`, "wait");

        for (let depositCount = 0; depositCount < dailyActivityConfig.depositRepetitions && !shouldStop; depositCount++) {
          const amount = (Math.random() * (dailyActivityConfig.maxAmountDeposit - dailyActivityConfig.minAmountDeposit) + dailyActivityConfig.minAmountDeposit).toFixed(4);
          addLog(`Account ${accountIndex + 1} - Deposit ${depositCount + 1}: Depositing ${amount} USDC as Collateral`, "start");
          try {
            await depositCollateral(wallet, amount);
            await updateWallets();
          } catch (error) {
            addLog(`Account ${accountIndex + 1} - Deposit ${depositCount + 1}: Failed: ${error.message}`, "error");
          }
          if (depositCount < dailyActivityConfig.depositRepetitions - 1 && !shouldStop) {
            const delay = Math.floor(Math.random() * (30000 - 10000) + 10000);
            addLog(`Account ${accountIndex + 1} - Waiting ${delay / 1000} seconds before next deposit...`, "delay");
            await sleep(delay);
          }
        }

        if (!shouldStop) {
          addLog(`Account ${accountIndex + 1} - Waiting 10 seconds before lend...`, "delay");
          await sleep(10000);
        }

        for (let lendCount = 0; lendCount < dailyActivityConfig.lendRepetitions && !shouldStop; lendCount++) {
          const amount = (Math.random() * (dailyActivityConfig.maxAmountLend - dailyActivityConfig.minAmountLend) + dailyActivityConfig.minAmountLend).toFixed(4);
          addLog(`Account ${accountIndex + 1} - Lend ${lendCount + 1}: Lending ${amount} USDC`, "start");
          try {
            await lend(wallet, amount);
            await updateWallets();
          } catch (error) {
            addLog(`Account ${accountIndex + 1} - Lend ${lendCount + 1}: Failed: ${error.message}`, "error");
          }
          if (lendCount < dailyActivityConfig.lendRepetitions - 1 && !shouldStop) {
            const delay = Math.floor(Math.random() * (30000 - 10000) + 10000);
            addLog(`Account ${accountIndex + 1} - Waiting ${delay / 1000} seconds before next lend...`, "delay");
            await sleep(delay);
          }
        }

        if (!shouldStop) {
          addLog(`Account ${accountIndex + 1} - Waiting 10 seconds before stake...`, "delay");
          await sleep(10000);
        }

        for (let stakeCount = 0; stakeCount < dailyActivityConfig.stakeRepetitions && !shouldStop; stakeCount++) {
          const amount = (Math.random() * (dailyActivityConfig.maxAmountStake - dailyActivityConfig.minAmountStake) + dailyActivityConfig.minAmountStake).toFixed(4);
          addLog(`Account ${accountIndex + 1} - Stake ${stakeCount + 1}: Staking ${amount} KLD`, "start");
          try {
            await stake(wallet, amount);
            await updateWallets();
          } catch (error) {
            addLog(`Account ${accountIndex + 1} - Stake ${stakeCount + 1}: Failed: ${error.message}`, "error");
          }
          if (stakeCount < dailyActivityConfig.stakeRepetitions - 1 && !shouldStop) {
            const delay = Math.floor(Math.random() * (30000 - 10000) + 10000);
            addLog(`Account ${accountIndex + 1} - Waiting ${delay / 1000} seconds before next stake...`, "delay");
            await sleep(delay);
          }
        }

        if (!shouldStop) {
          addLog(`Account ${accountIndex + 1} - Waiting 10 seconds before claim faucet...`, "delay");
          await sleep(10000);
        }

        if (!shouldStop) {
          addLog(`Account ${accountIndex + 1} - Claim Faucet: Starting Claim Faucet KLD & USDC`, "start");
          try {
            await claimFaucet(wallet);
            await updateWallets();
          } catch (error) {
            addLog(`Account ${accountIndex + 1} - Claim Faucet: Failed: ${error.message}`, "error");
          }
        }

        if (accountIndex < privateKeys.length - 1 && !shouldStop) {
          addLog(`Waiting ${dailyActivityConfig.accountDelay / 1000} seconds before next account...`, "delay");
          await sleep(dailyActivityConfig.accountDelay);
        }
      }
      if (!shouldStop && activeProcesses <= 0) {
        const intervalHours = dailyActivityConfig.cycleIntervalHours;
        const intervalMs = intervalHours * 60 * 60 * 1000;
        addLog(`All accounts processed. Waiting ${intervalHours} Hours until next cycle.`, "success");
        dailyActivityInterval = setTimeout(runDailyActivity, intervalMs);
      }
    } catch (error) {
      addLog(`Daily activity failed: ${error.message}`, "error");
    } finally {
      isActivityRunning = false;
      isScheduled = dailyActivityInterval !== null;
      isCycleRunning = isActivityRunning || isScheduled;
      updateMenu();
      updateStatus();
      safeRender();
    }
  }

  const screen = blessed.screen({
    smartCSR: true,
    title: "KALEIDO TESTNET AUTO BOT",
    autoPadding: true,
    fullUnicode: true,
    mouse: true,
    ignoreLocked: ["C-c", "q", "escape"]
  });

  const headerBox = blessed.box({
    top: 0,
    left: "center",
    width: "100%",
    height: 6,
    tags: true,
    style: { fg: "yellow", bg: "default" }
  });

  const statusBox = blessed.box({
    left: 0,
    top: 6,
    width: "100%",
    height: 3,
    tags: true,
    border: { type: "line", fg: "cyan" },
    style: { fg: "white", bg: "default", border: { fg: "cyan" } },
    content: "Status: Initializing...",
    padding: { left: 1, right: 1, top: 0, bottom: 0 },
    label: chalk.cyan(" Status ")
  });

  const walletBox = blessed.list({
    label: " Wallet Information",
    top: 9,
    left: 0,
    width: "40%",
    height: "35%",
    border: { type: "line", fg: "cyan" },
    style: { border: { fg: "cyan" }, fg: "white", bg: "default", item: { fg: "white" } },
    scrollable: true,
    scrollbar: { bg: "cyan", fg: "black" },
    padding: { left: 1, right: 1, top: 0, bottom: 0 },
    tags: true,
    keys: true,
    vi: true,
    mouse: true,
    content: "Loading wallet data..."
  });

  const logBox = blessed.log({
    label: " Transaction Logs",
    top: 9,
    left: "41%",
    width: "60%",
    height: "100%-9",
    border: { type: "line" },
    scrollable: true,
    alwaysScroll: true,
    mouse: true,
    tags: true,
    scrollbar: { ch: "│", style: { bg: "cyan", fg: "white" }, track: { bg: "gray" } },
    scrollback: 100,
    smoothScroll: true,
    style: { border: { fg: "magenta" }, bg: "default", fg: "white" },
    padding: { left: 1, right: 1, top: 0, bottom: 0 },
    wrap: true,
    focusable: true,
    keys: true
  });

  const menuBox = blessed.list({
    label: " Menu ",
    top: "44%",
    left: 0,
    width: "40%",
    height: "56%",
    keys: true,
    vi: true,
    mouse: true,
    border: { type: "line" },
    style: { fg: "white", bg: "default", border: { fg: "red" }, selected: { bg: "magenta", fg: "black" }, item: { fg: "white" } },
    items: [
      "Start Auto Daily Activity",
      "Set Manual Config",
      "Clear Logs",
      "Refresh",
      "Exit"
    ],
    padding: { left: 1, top: 1 }
  });

  const dailyActivitySubMenu = blessed.list({
    label: " Manual Config Options ",
    top: "44%",
    left: 0,
    width: "40%",
    height: "56%",
    keys: true,
    vi: true,
    mouse: true,
    border: { type: "line" },
    style: { fg: "white", bg: "default", border: { fg: "blue" }, selected: { bg: "blue", fg: "black" }, item: { fg: "white" } },
    items: [
      "Set Deposit Repetitions",
      "Set Amount Range For Deposit",
      "Set Lend Repetitions",
      "Set Amount Range For Lend",
      "Set Stake Repetitions",
      "Set Amount Range For Stake",
      "Set Cycle Interval (hours)",
      "Back to Main Menu"
    ],
    padding: { left: 1, top: 1 },
    hidden: true
  });

const configForm = blessed.form({
  label: " Enter Config Value ",
  top: "center",
  left: "center",
  width: "30%",
  height: "40%",
  keys: true,
  mouse: true,
  border: { type: "line" },
  style: { fg: "white", bg: "default", border: { fg: "blue" } },
  padding: { left: 1, top: 1 },
  hidden: true
});

const minLabel = blessed.text({
  parent: configForm,
  top: 0,
  left: 1,
  content: "Min Value:",
  style: { fg: "white" }
});

const maxLabel = blessed.text({
  parent: configForm,
  top: 4,
  left: 1,
  content: "Max Value:",
  style: { fg: "white" }
});

const configInput = blessed.textbox({
  parent: configForm,
  top: 1,
  left: 1,
  width: "90%",
  height: 3,
  inputOnFocus: true,
  border: { type: "line" },
  style: { fg: "white", bg: "default", border: { fg: "white" }, focus: { border: { fg: "green" } } }
});

const configInputMax = blessed.textbox({
  parent: configForm,
  top: 5,
  left: 1,
  width: "90%",
  height: 3,
  inputOnFocus: true,
  border: { type: "line" },
  style: { fg: "white", bg: "default", border: { fg: "white" }, focus: { border: { fg: "green" } } }
});

const configSubmitButton = blessed.button({
  parent: configForm,
  top: 9,
  left: "center",
  width: 10,
  height: 3,
  content: "Submit",
  align: "center",
  border: { type: "line" },
  clickable: true,
  keys: true,
  style: { fg: "white", bg: "blue", border: { fg: "white" }, hover: { bg: "green" }, focus: { bg: "green", border: { fg: "yellow" } } }
});


  screen.append(headerBox);
  screen.append(statusBox);
  screen.append(walletBox);
  screen.append(logBox);
  screen.append(menuBox);
  screen.append(dailyActivitySubMenu);
  screen.append(configForm);

  let renderQueue = [];
  let isRendering = false;
  function safeRender() {
    renderQueue.push(true);
    if (isRendering) return;
    isRendering = true;
    setTimeout(() => {
      try {
        if (!isHeaderRendered) {
          figlet.text("NT EXHAUST", { font: "ANSI Shadow" }, (err, data) => {
            if (!err) headerBox.setContent(`{center}{bold}{cyan-fg}${data}{/cyan-fg}{/bold}{/center}`);
            isHeaderRendered = true;
          });
        }
        screen.render();
      } catch (error) {
        addLog(`UI render error: ${error.message}`, "error");
      }
      renderQueue.shift();
      isRendering = false;
      if (renderQueue.length > 0) safeRender();
    }, 100);
  }

  function adjustLayout() {
    const screenHeight = screen.height || 24;
    const screenWidth = screen.width || 80;
    headerBox.height = Math.max(6, Math.floor(screenHeight * 0.15));
    statusBox.top = headerBox.height;
    statusBox.height = Math.max(3, Math.floor(screenHeight * 0.07));
    walletBox.top = headerBox.height + statusBox.height;
    walletBox.width = Math.floor(screenWidth * 0.4);
    walletBox.height = Math.floor(screenHeight * 0.35);
    logBox.top = headerBox.height + statusBox.height;
    logBox.left = Math.floor(screenWidth * 0.41);
    logBox.width = Math.floor(screenWidth * 0.6);
    logBox.height = screenHeight - (headerBox.height + statusBox.height);
    menuBox.top = headerBox.height + statusBox.height + walletBox.height;
    menuBox.width = Math.floor(screenWidth * 0.4);
    menuBox.height = screenHeight - (headerBox.height + statusBox.height + walletBox.height);
    dailyActivitySubMenu.top = menuBox.top;
    dailyActivitySubMenu.width = menuBox.width;
    dailyActivitySubMenu.height = menuBox.height;
    dailyActivitySubMenu.left = menuBox.left;
    configForm.width = Math.floor(screenWidth * 0.3);
    configForm.height = Math.floor(screenHeight * 0.4);
    safeRender();
  }

  function updateStatus() {
    try {
      const isProcessing = isActivityRunning || (isScheduled && dailyActivityInterval !== null);
      const status = isActivityRunning
        ? `${loadingSpinner[spinnerIndex]} ${chalk.yellowBright("Running")}`
        : isScheduled && dailyActivityInterval !== null
        ? `${loadingSpinner[spinnerIndex]} ${chalk.yellowBright("Waiting for next cycle")}`
        : chalk.green("Idle");
      const statusText = `Status: ${status} | Active Account: ${getShortAddress(walletInfo.address)} | Total Accounts: ${privateKeys.length} | Auto Deposit: ${dailyActivityConfig.depositRepetitions}x | Auto Lend: ${dailyActivityConfig.lendRepetitions}x | Auto Stake: ${dailyActivityConfig.stakeRepetitions}x | Auto Claim Faucet: 1x | KALEIDO AUTO BOT`;
      statusBox.setContent(statusText);
      if (isProcessing) {
        if (blinkCounter % 1 === 0) {
          statusBox.style.border.fg = borderBlinkColors[borderBlinkIndex];
          borderBlinkIndex = (borderBlinkIndex + 1) % borderBlinkColors.length;
        }
        blinkCounter++;
      } else {
        statusBox.style.border.fg = "cyan";
      }
      spinnerIndex = (spinnerIndex + 1) % loadingSpinner.length;
      safeRender();
    } catch (error) {
      addLog(`Status update error: ${error.message}`, "error");
    }
  }

  async function updateWallets() {
    try {
      const walletData = await updateWalletData();
      const header = `${chalk.bold.cyan("    Address").padEnd(12)}         ${chalk.bold.cyan("ETH".padEnd(8))}   ${chalk.bold.green("USDC".padEnd(8))}   ${chalk.bold.yellow("KLD".padEnd(8))}`;
      const separator = chalk.gray("-".repeat(50));
      walletBox.setItems([header, separator, ...walletData]);
      walletBox.select(0);
      safeRender();
    } catch (error) {
      addLog(`Failed to update wallet data: ${error.message}`, "error");
    }
  }

  function updateLogs() {
    try {
      logBox.add(transactionLogs[transactionLogs.length - 1] || chalk.gray("No logs available."));
      safeRender();
    } catch (error) {
      addLog(`Log update failed: ${error.message}`, "error");
    }
  }

  function updateMenu() {
    try {
      let menuItems = [
        "Set Manual Config",
        "Clear Logs",
        "Refresh",
        "Exit"
      ];
      if (isActivityRunning) menuItems.unshift("Stop Current Activity");
      if (isScheduled && !isActivityRunning) menuItems.unshift("Cancel Scheduled Activity");
      if (!isActivityRunning && !isScheduled) menuItems.unshift("Start Auto Daily Activity");
      menuBox.setItems(menuItems);
      safeRender();
    } catch (error) {
      addLog(`Menu update failed: ${error.message}`, "error");
    }
  }

  const statusInterval = setInterval(updateStatus, 100);

  logBox.key(["up"], () => {
    if (screen.focused === logBox) {
      logBox.scroll(-1);
      safeRender();
    }
  });

  logBox.key(["down"], () => {
    if (screen.focused === logBox) {
      logBox.scroll(1);
      safeRender();
    }
  });

  logBox.on("click", () => {
    screen.focusPush(logBox);
    logBox.style.border.fg = "yellow";
    menuBox.style.border.fg = "red";
    dailyActivitySubMenu.style.border.fg = "blue";
    safeRender();
  });

  logBox.on("blur", () => {
    logBox.style.border.fg = "magenta";
    safeRender();
  });

  menuBox.on("select", async (item) => {
    const action = item.getText();
    switch (action) {
      case "Start Auto Daily Activity":
        if (isCycleRunning) {
          addLog("Cycle is still running. Stop or cancel the current cycle first.", "error");
        } else {
          await runDailyActivity();
        }
        break;
      case "Stop Current Activity":
        shouldStop = true;
        addLog("Stopping current activity. Please wait for ongoing process to complete.", "info");
        const stopCheckInterval = setInterval(() => {
          if (activeProcesses <= 0) {
            clearInterval(stopCheckInterval);
            isActivityRunning = false;
            isCycleRunning = isScheduled;
            shouldStop = false;
            hasLoggedSleepInterrupt = false;
            activeProcesses = 0;
            addLog("Current activity stopped successfully.", "success");
            updateMenu();
            updateStatus();
            safeRender();
          } else {
            addLog(`Waiting for ${activeProcesses} process(es) to complete...`, "info");
            safeRender();
          }
        }, 1000);
        break;
      case "Cancel Scheduled Activity":
        if (dailyActivityInterval) {
          clearTimeout(dailyActivityInterval);
          dailyActivityInterval = null;
          isScheduled = false;
          isCycleRunning = false;
          addLog("Scheduled activity canceled.", "info");
          updateMenu();
          updateStatus();
          safeRender();
        }
        break;
      case "Set Manual Config":
        menuBox.hide();
        dailyActivitySubMenu.show();
        setTimeout(() => {
          if (dailyActivitySubMenu.visible) {
            screen.focusPush(dailyActivitySubMenu);
            dailyActivitySubMenu.style.border.fg = "yellow";
            logBox.style.border.fg = "magenta";
            safeRender();
          }
        }, 100);
        break;
      case "Clear Logs":
        clearTransactionLogs();
        break;
      case "Refresh":
        await updateWallets();
        addLog("Data refreshed.", "success");
        break;
      case "Exit":
        addLog("Exiting application", "info");
        clearInterval(statusInterval);
        process.exit(0);
    }
  });

  dailyActivitySubMenu.on("select", (item) => {
    const action = item.getText();
    switch (action) {
      case "Set Deposit Repetitions":
        configForm.configType = "depositRepetitions";
        configForm.setLabel(" Enter Deposit Repetitions ");
        minLabel.hide();
        maxLabel.hide();
        configInput.clearValue();
        configInputMax.clearValue();
        configInputMax.hide();
        configForm.show();
        setTimeout(() => {
          if (configForm.visible) {
            screen.focusPush(configInput);
            safeRender();
          }
        }, 100);
        break;
      case "Set Amount Range For Deposit":
        configForm.configType = "amountRangeDeposit";
        configForm.setLabel(" Enter Amount Range for Deposit ");
        minLabel.show();
        maxLabel.show();
        configInput.clearValue();
        configInputMax.clearValue();
        configInputMax.show();
        configForm.show();
        setTimeout(() => {
          if (configForm.visible) {
            screen.focusPush(configInput);
            safeRender();
          }
        }, 100);
        break;
      case "Set Lend Repetitions":
        configForm.configType = "lendRepetitions";
        configForm.setLabel(" Enter Lend Repetitions ");
        minLabel.hide();
        maxLabel.hide();
        configInput.clearValue();
        configInputMax.clearValue();
        configInputMax.hide();
        configForm.show();
        setTimeout(() => {
          if (configForm.visible) {
            screen.focusPush(configInput);
            safeRender();
          }
        }, 100);
        break;
      case "Set Amount Range For Lend":
        configForm.configType = "amountRangeLend";
        configForm.setLabel(" Enter Amount Range for Lend ");
        minLabel.show();
        maxLabel.show();
        configInput.clearValue();
        configInputMax.clearValue();
        configInputMax.show();
        configForm.show();
        setTimeout(() => {
          if (configForm.visible) {
            screen.focusPush(configInput);
            safeRender();
          }
        }, 100);
        break;
      case "Set Stake Repetitions":
        configForm.configType = "stakeRepetitions";
        configForm.setLabel(" Enter Stake Repetitions ");
        minLabel.hide();
        maxLabel.hide();
        configInput.clearValue();
        configInputMax.clearValue();
        configInputMax.hide();
        configForm.show();
        setTimeout(() => {
          if (configForm.visible) {
            screen.focusPush(configInput);
            safeRender();
          }
        }, 100);
        break;
      case "Set Amount Range For Stake":
        configForm.configType = "amountRangeStake";
        configForm.setLabel(" Enter Amount Range for Stake ");
        minLabel.show();
        maxLabel.show();
        configInput.clearValue();
        configInputMax.clearValue();
        configInputMax.show();
        configForm.show();
        setTimeout(() => {
          if (configForm.visible) {
            screen.focusPush(configInput);
            safeRender();
          }
        }, 100);
        break;
      case "Set Cycle Interval (hours)":
        configForm.configType = "cycleIntervalHours";
        configForm.setLabel(" Enter Cycle Interval (hours) ");
        minLabel.hide();
        maxLabel.hide();
        configInput.setValue(dailyActivityConfig.cycleIntervalHours.toString());
        configInputMax.clearValue();
        configInputMax.hide();
        configForm.show();
        setTimeout(() => {
          if (configForm.visible) {
            screen.focusPush(configInput);
            safeRender();
          }
        }, 100);
        break;
      case "Back to Main Menu":
        dailyActivitySubMenu.hide();
        menuBox.show();
        setTimeout(() => {
          if (menuBox.visible) {
            screen.focusPush(menuBox);
            menuBox.style.border.fg = "cyan";
            dailyActivitySubMenu.style.border.fg = "blue";
            logBox.style.border.fg = "magenta";
            safeRender();
          }
        }, 100);
        break;
    }
  });

configForm.on("submit", () => {
  const inputValue = configInput.getValue().trim();
  let value, maxValue;

  try {
    value = parseFloat(inputValue);
    if (configForm.configType.includes("amountRange")) {
      maxValue = parseFloat(configInputMax.getValue().trim());
      if (isNaN(maxValue) || maxValue <= 0) {
        addLog("Invalid Max value. Please enter a positive number.", "error");
        configInputMax.clearValue(); 
        screen.focusPush(configInputMax);
        safeRender();
        return;
      }
    }
    if (isNaN(value) || value <= 0) {
      addLog("Invalid input. Please enter a positive number.", "error");
      configInput.clearValue();
      screen.focusPush(configInput);
      safeRender();
      return;
    }
    if (configForm.configType === "cycleIntervalHours" && value < 1) {
      addLog("Cycle interval must be at least 1 hour.", "error");
      configInput.clearValue(); 
      screen.focusPush(configInput);
      safeRender();
      return;
    }
  } catch (error) {
    addLog(`Invalid format: ${error.message}`, "error");
    configInput.clearValue();
    screen.focusPush(configInput);
    safeRender();
    return;
  }

  if (configForm.configType === "depositRepetitions") {
    dailyActivityConfig.depositRepetitions = Math.floor(value);
    addLog(`Deposit Repetitions set to ${dailyActivityConfig.depositRepetitions}`, "success");
  } else if (configForm.configType === "amountRangeDeposit") {
    if (value > maxValue) {
      addLog("Min amount cannot be greater than Max amount.", "error");
      configInput.clearValue();
      configInputMax.clearValue();
      screen.focusPush(configInput);
      safeRender();
      return;
    }
    dailyActivityConfig.minAmountDeposit = value;
    dailyActivityConfig.maxAmountDeposit = maxValue;
    addLog(`Amount Range for Deposit set to ${dailyActivityConfig.minAmountDeposit} - ${dailyActivityConfig.maxAmountDeposit}`, "success");
  } else if (configForm.configType === "lendRepetitions") {
    dailyActivityConfig.lendRepetitions = Math.floor(value);
    addLog(`Lend Repetitions set to ${dailyActivityConfig.lendRepetitions}`, "success");
  } else if (configForm.configType === "amountRangeLend") {
    if (value > maxValue) {
      addLog("Min amount cannot be greater than Max amount.", "error");
      configInput.clearValue();
      configInputMax.clearValue();
      screen.focusPush(configInput);
      safeRender();
      return;
    }
    dailyActivityConfig.minAmountLend = value;
    dailyActivityConfig.maxAmountLend = maxValue;
    addLog(`Amount Range for Lend set to ${dailyActivityConfig.minAmountLend} - ${dailyActivityConfig.maxAmountLend}`, "success");
  } else if (configForm.configType === "stakeRepetitions") {
    dailyActivityConfig.stakeRepetitions = Math.floor(value);
    addLog(`Stake Repetitions set to ${dailyActivityConfig.stakeRepetitions}`, "success");
  } else if (configForm.configType === "amountRangeStake") {
    if (value > maxValue) {
      addLog("Min amount cannot be greater than Max amount.", "error");
      configInput.clearValue();
      configInputMax.clearValue();
      screen.focusPush(configInput);
      safeRender();
      return;
    }
    dailyActivityConfig.minAmountStake = value;
    dailyActivityConfig.maxAmountStake = maxValue;
    addLog(`Amount Range for Stake set to ${dailyActivityConfig.minAmountStake} - ${dailyActivityConfig.maxAmountStake}`, "success");
  } else if (configForm.configType === "cycleIntervalHours") {
    dailyActivityConfig.cycleIntervalHours = Math.floor(value);
    addLog(`Cycle Interval set to ${dailyActivityConfig.cycleIntervalHours} Hours`, "success");
  }
  saveConfig();
  updateStatus();
  configForm.hide();
  configInput.clearValue();
  configInputMax.clearValue();
  dailyActivitySubMenu.show();
  setTimeout(() => {
    if (dailyActivitySubMenu.visible) {
      screen.focusPush(dailyActivitySubMenu);
      dailyActivitySubMenu.style.border.fg = "yellow";
      logBox.style.border.fg = "magenta";
      safeRender();
    }
  }, 100);
});

configInput.key(["enter"], () => {
  if (configForm.configType.includes("amountRange")) {
    screen.focusPush(configInputMax);
  } else {
    configForm.submit(); 
  }
});

configInputMax.key(["enter"], () => {
  configForm.submit(); 
});

configSubmitButton.on("press", () => {
  configForm.submit();
});

configSubmitButton.on("click", () => {
  configForm.submit();
});

configForm.key(["escape"], () => {
  configForm.hide();
  configInput.clearValue();
  configInputMax.clearValue();
  dailyActivitySubMenu.show();
  setTimeout(() => {
    if (dailyActivitySubMenu.visible) {
      screen.focusPush(dailyActivitySubMenu);
      dailyActivitySubMenu.style.border.fg = "yellow";
      logBox.style.border.fg = "magenta";
      safeRender();
    }
  }, 100);
});


dailyActivitySubMenu.key(["escape"], () => {
    dailyActivitySubMenu.hide();
    menuBox.show();
    setTimeout(() => {
      if (menuBox.visible) {
        screen.focusPush(menuBox);
        menuBox.style.border.fg = "cyan";
        dailyActivitySubMenu.style.border.fg = "blue";
        logBox.style.border.fg = "magenta";
        safeRender();
      }
    }, 100);
  });

  screen.key(["escape", "q", "C-c"], () => {
    addLog("Exiting application", "info");
    clearInterval(statusInterval);
    process.exit(0);
  });

  async function initialize() {
    try {
      loadConfig();
      loadPrivateKeys();
      loadProxies();
      updateStatus();
      await updateWallets();
      updateLogs();
      safeRender();
      menuBox.focus();
    } catch (error) {
      addLog(`Initialization error: ${error.message}`, "error");
    }
  }

  setTimeout(() => {
    adjustLayout();
    screen.on("resize", adjustLayout);
  }, 100);

  initialize();
