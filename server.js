/**
 * ===============================================================================
 * APEX TITAN v127.0 (MULTI-CHAIN LEVIATHAN)
 * ===============================================================================
 * BASE: v57.0 (Multi-Chain) | ENGINE: Max Flash Logic (v100)
 * -------------------------------------------------------------------------------
 * FEATURES:
 * 1. MULTI-CHAIN: Scans ETH, BASE, POLY, ARB simultaneously.
 * 2. MAX FLASH LOAN: 100% Wallet Utilization per chain.
 * 3. GAS FIX: Solves "Priority > Max" error on L2s.
 * 4. NATIVE: No Axios dependency.
 * ===============================================================================
 */

const cluster = require('cluster');
const os = require('os');
const http = require('http');
const WebSocket = require("ws");
const { 
    ethers, JsonRpcProvider, Wallet, Contract, FallbackProvider, 
    WebSocketProvider, parseEther, formatEther, Interface 
} = require('ethers');
require('dotenv').config();

// --- AEGIS SHIELD ---
process.setMaxListeners(500);
process.on('uncaughtException', (err) => {
    const msg = err.message || "";
    if (msg.includes('429') || msg.includes('32005') || msg.includes('coalesce') || msg.includes('Handshake')) return;
    console.error(`[CRITICAL] ${msg}`);
});

const TXT = { green: "\x1b[32m", gold: "\x1b[38;5;220m", reset: "\x1b[0m", red: "\x1b[31m", cyan: "\x1b[36m" };

// --- CONFIGURATION ---
const NETWORKS = {
    ETHEREUM: {
        chainId: 1,
        rpc: [process.env.ETH_RPC, "https://eth.llamarpc.com", "https://rpc.ankr.com/eth"],
        wss: [process.env.ETH_WSS, "wss://eth.llamarpc.com", "wss://ethereum.publicnode.com"],
        relay: "https://relay.flashbots.net",
        isL2: false
    },
    BASE: {
        chainId: 8453,
        rpc: [process.env.BASE_RPC, "https://mainnet.base.org", "https://base.llamarpc.com"],
        wss: [process.env.BASE_WSS, "wss://base.publicnode.com", "wss://base-rpc.publicnode.com"],
        isL2: true
    },
    POLYGON: {
        chainId: 137,
        rpc: [process.env.POLYGON_RPC, "https://polygon-rpc.com", "https://rpc-mainnet.maticvigil.com"],
        wss: [process.env.POLYGON_WSS, "wss://polygon-bor-rpc.publicnode.com"],
        isL2: true
    },
    ARBITRUM: {
        chainId: 42161,
        rpc: [process.env.ARBITRUM_RPC, "https://arb1.arbitrum.io/rpc", "https://arbitrum.llamarpc.com"],
        wss: [process.env.ARBITRUM_WSS, "wss://arbitrum-one.publicnode.com"],
        isL2: true
    }
};

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const EXECUTOR_ADDRESS = process.env.EXECUTOR_ADDRESS;
const GAS_LIMIT = 1500000n; // High limit for complex routing
const MIN_BALANCE = parseEther("0.001");

const poolIndex = { ETHEREUM: 0, BASE: 0, POLYGON: 0, ARBITRUM: 0 };

// Sanitizer
function sanitize(k) {
    let s = (k || "").trim().replace(/['" \n\r]+/g, '');
    if (!s.startsWith("0x")) s = "0x" + s;
    return s;
}

async function main() {
    console.clear();
    console.log(`${TXT.gold}╔════════════════════════════════════════════════════════╗`);
    console.log(`║    ⚡ APEX TITAN v127.0 | MULTI-CHAIN LEVIATHAN         ║`);
    console.log(`║    MODE: ABSOLUTE MAX FLASH (100% UTILIZATION)         ║`);
    console.log(`║    TARGET: ${EXECUTOR_ADDRESS ? EXECUTOR_ADDRESS : "SELF (TEST)"}      ║`);
    console.log(`╚════════════════════════════════════════════════════════╝${TXT.reset}\n`);

    Object.entries(NETWORKS).forEach(([name, config]) => {
        initializeEngine(name, config).catch(err => {
            console.error(`[${name}] Init Error:`, err.message);
        });
    });
}

async function initializeEngine(name, config) {
    const rpcUrl = config.rpc[poolIndex[name] % config.rpc.length] || config.rpc[0];
    const wssUrl = config.wss[poolIndex[name] % config.wss.length] || config.wss[0];

    if (!rpcUrl || !wssUrl) return;

    const network = ethers.Network.from(config.chainId);
    const provider = new JsonRpcProvider(rpcUrl, network, { staticNetwork: network });
    let wallet = new Wallet(sanitize(PRIVATE_KEY), provider);
    
    // V100 Interface
    const iface = new Interface(["function executeComplexPath(string[] path, uint256 amount)"]);

    let flashbots = null;
    if (!config.isL2 && config.relay) {
        try {
            const authSigner = Wallet.createRandom();
            flashbots = await FlashbotsBundleProvider.create(provider, authSigner, config.relay);
        } catch (e) {}
    }

    const ws = new WebSocket(wssUrl);

    ws.on('open', () => {
        console.log(`${TXT.cyan}[${name}] Connected to SpeedStream.${TXT.reset}`);
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["newPendingTransactions"] }));
    });

    ws.on('message', async (data) => {
        let payload;
        try { payload = JSON.parse(data); } catch (e) { return; }
        if (payload.id === 1) return;

        if (payload.params && payload.params.result) {
            const txHash = payload.params.result;
            try {
                const [bal, feeData] = await Promise.all([
                    provider.getBalance(wallet.address),
                    provider.getFeeData()
                ]);

                if (bal < MIN_BALANCE) return;

                // --- GAS MATH REPAIR ---
                const baseFee = feeData.gasPrice || parseEther("0.01", "gwei");
                // Aggressive Priority for L2s (Base/Arb/Poly)
                const priorityFee = config.isL2 ? parseEther("1.5", "gwei") : parseEther("2.0", "gwei");
                // Max must be > Base + Priority
                const maxFee = baseFee + priorityFee + parseEther("0.1", "gwei");

                const estimatedGasCost = GAS_LIMIT * maxFee;
                const availableForPremium = bal - estimatedGasCost;
                
                if (availableForPremium <= 0n) return;

                // --- MAX FLASH CALCULATION ---
                // Loan = Fee / 0.0009
                const tradeAmount = (availableForPremium * 10000n) / 9n;
                const txValue = (tradeAmount * 9n) / 10000n; // Fee we send

                // --- ENCODE V100 DATA ---
                // "ETH" maps to WETH/WMATIC in contract
                const path = ["ETH", "USDC", "ETH"]; 
                const data = iface.encodeFunctionData("executeComplexPath", [path, tradeAmount]);

                const tx = {
                    to: EXECUTOR_ADDRESS || wallet.address,
                    data: EXECUTOR_ADDRESS ? data : "0x",
                    value: txValue,
                    gasLimit: GAS_LIMIT,
                    maxFeePerGas: maxFee,
                    maxPriorityFeePerGas: priorityFee,
                    type: 2,
                    chainId: config.chainId
                };

                if (flashbots && name === "ETHEREUM") {
                    const bundle = [{ signer: wallet, transaction: tx }];
                    const block = await provider.getBlockNumber() + 1;
                    const simulation = await flashbots.simulate(bundle, block);
                    if ("error" in simulation || simulation.results[0].revert) return;
                    await flashbots.sendBundle(bundle, block);
                    console.log(`${TXT.gold}[${name}] Flashbots Bundle Sent!${TXT.reset}`);
                } else {
                    const signed = await wallet.signTransaction(tx);
                    
                    // Native Fetch Broadcast (No Axios)
                    fetch(rpcUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            jsonrpc: "2.0",
                            id: 1,
                            method: "eth_sendRawTransaction",
                            params: [signed]
                        })
                    }).catch(() => {});

                    // Redundant Broadcast
                    wallet.sendTransaction(tx).catch(() => {});
                    
                    console.log(`${TXT.green}[${name}] 🚀 STRIKE! Loan: ${formatEther(tradeAmount)} ETH | Fee: ${formatEther(txValue)}${TXT.reset}`);
                }
            } catch (err) {
                // Silent fail for speed
            }
        }
    });

    ws.on('error', () => ws.terminate());
    ws.on('close', () => {
        poolIndex[name]++;
        setTimeout(() => initializeEngine(name, config), 5000);
    });
}

main().catch(console.error);
