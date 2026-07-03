import { useState } from 'react'
import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import { 
  Search, Copy, ExternalLink, AlertCircle, CheckCircle, Loader2, 
  Wallet, ArrowRight, Info 
} from 'lucide-react'
import { toast } from 'sonner'

interface Sender {
  from: string
  amount: number
  sig: string
  time: string | null
}

interface CheckResult {
  mint: string
  exists: boolean
  program: string
  currentSOL: number
  rentSOL: number
  excessSOL: number
  isRecoverable: boolean
  mintAuthority: string | null
  freezeAuthority: string | null
  decimals: number
  supply: string
  creator: string | null
  creationSig: string | null
  creationTime: string | null
  senders: Sender[]
  tokenName?: string
  tokenSymbol?: string
}

const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com'
const DUNE_URL = 'https://dune.com/parkernoir7826/recoverable-sol'

// Sample mints for demo (you can add real ones that have excess if known)
const SAMPLE_MINTS = [
  { label: 'Example (USDC)', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
  { label: 'Example (BONK)', mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
]

function shorten(addr: string, chars = 4) {
  return addr.length > 10 ? `${addr.slice(0, chars)}...${addr.slice(-chars)}` : addr
}

function isValidMint(addr: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr.trim())
}

function extractMint(input: string): string {
  const trimmed = input.trim()
  // Support pasting solscan or other urls
  const match = trimmed.match(/([1-9A-HJ-NP-Za-km-z]{32,44})/)
  return match ? match[1] : trimmed
}

async function fetchTokenInfo(mint: string): Promise<{ name?: string; symbol?: string } | null> {
  try {
    const res = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mint}`)
    if (!res.ok) return null
    const data = await res.json()
    if (Array.isArray(data) && data[0]?.baseToken) {
      return {
        name: data[0].baseToken.name,
        symbol: data[0].baseToken.symbol,
      }
    }
  } catch {
    // ignore
  }
  return null
}

async function checkMint(
  mintAddress: string, 
  rpcUrl: string,
  doTrace = true
): Promise<CheckResult> {
  const connection = new Connection(rpcUrl, 'confirmed')
  const mint = new PublicKey(mintAddress)

  // Basic account info + balance
  const accountInfo = await connection.getAccountInfo(mint)
  if (!accountInfo) {
    throw new Error('Mint account not found on-chain')
  }

  const lamports = accountInfo.lamports
  const dataLen = accountInfo.data.length
  const rentExempt = await connection.getMinimumBalanceForRentExemption(dataLen)

  const currentSOL = lamports / LAMPORTS_PER_SOL
  const rentSOL = rentExempt / LAMPORTS_PER_SOL
  const excessSOL = Math.max(0, (lamports - rentExempt) / LAMPORTS_PER_SOL)
  const isRecoverable = excessSOL > 0.000001

  const program = accountInfo.owner.equals(TOKEN_2022_PROGRAM_ID)
    ? 'Token-2022'
    : accountInfo.owner.equals(TOKEN_PROGRAM_ID)
      ? 'Token Program'
      : accountInfo.owner.toBase58()

  // Parsed mint data
  let mintAuthority: string | null = null
  let freezeAuthority: string | null = null
  let decimals = 0
  let supply = '0'

  try {
    const parsed = await connection.getParsedAccountInfo(mint)
    const parsedData = parsed.value?.data
    if (parsedData && 'parsed' in parsedData && parsedData.parsed?.type === 'mint') {
      const info = parsedData.parsed.info
      mintAuthority = info.mintAuthority
      freezeAuthority = info.freezeAuthority
      decimals = info.decimals
      supply = info.supply
    }
  } catch {
    // best effort
  }

  // Token metadata (name/symbol) from public API
  const meta = await fetchTokenInfo(mintAddress)

  let creator: string | null = null
  let creationSig: string | null = null
  let creationTime: string | null = null
  let senders: Sender[] = []

  if (doTrace) {
    // Get recent signatures (newest first)
    const signatures = await connection.getSignaturesForAddress(mint, { limit: 60 })

    // Find creator: scan from oldest
    for (let i = signatures.length - 1; i >= 0; i--) {
      const s = signatures[i]
      if (s.err) continue
      try {
        const tx = await connection.getParsedTransaction(s.signature, {
          maxSupportedTransactionVersion: 0,
        })
        if (!tx) continue

        const message = tx.transaction.message
        const ixns = message.instructions

        let foundInit = false
        for (const ix of ixns) {
          const pid = ('programId' in ix ? ix.programId?.toString() : (ix as any).program?.toString()) || ''
          if (pid !== TOKEN_PROGRAM_ID.toBase58() && pid !== TOKEN_2022_PROGRAM_ID.toBase58()) continue

          const parsedIx = (ix as any).parsed
          if (parsedIx && (parsedIx.type === 'initializeMint' || parsedIx.type === 'initializeMint2')) {
            foundInit = true
            break
          }
        }

        if (foundInit || i === signatures.length - 1) {
          // Use first fee payer as likely creator
          const feePayerKey = message.accountKeys?.[0]
          creator = typeof feePayerKey === 'string' ? feePayerKey : feePayerKey?.pubkey?.toBase58?.() || feePayerKey?.toString?.()
          creationSig = s.signature
          creationTime = s.blockTime ? new Date(s.blockTime * 1000).toLocaleString() : null
          if (foundInit) break
        }
      } catch {
        // continue scanning
      }
    }

    // Trace incoming SOL transfers
    const sendersFound: Sender[] = []
    for (const s of signatures.slice(0, 25)) {
      if (s.err) continue
      try {
        const tx = await connection.getParsedTransaction(s.signature, {
          maxSupportedTransactionVersion: 0,
        })
        if (!tx?.meta) continue

        const keys: string[] = (tx.transaction.message.accountKeys || []).map((k: any) =>
          typeof k === 'string' ? k : (k.pubkey?.toBase58?.() || k.toString?.() || '')
        )
        const mintIdx = keys.findIndex(k => k === mintAddress)
        if (mintIdx === -1) continue

        const pre = tx.meta.preBalances?.[mintIdx] ?? 0
        const post = tx.meta.postBalances?.[mintIdx] ?? 0
        const delta = post - pre
        if (delta <= 1000) continue // ignore tiny dust / fees

        // Try to locate the source of funds
        let from = keys[0] || 'unknown'
        for (let j = 0; j < keys.length; j++) {
          if (j === mintIdx) continue
          const d = (tx.meta.postBalances?.[j] ?? 0) - (tx.meta.preBalances?.[j] ?? 0)
          if (d < -1000 && Math.abs(d + delta) < 10000) {
            from = keys[j]
            break
          }
        }

        sendersFound.push({
          from,
          amount: delta / LAMPORTS_PER_SOL,
          sig: s.signature,
          time: s.blockTime ? new Date(s.blockTime * 1000).toISOString() : null,
        })

        if (sendersFound.length >= 8) break
      } catch {
        // skip problematic txs
      }
    }
    senders = sendersFound
  }

  return {
    mint: mintAddress,
    exists: true,
    program,
    currentSOL,
    rentSOL,
    excessSOL,
    isRecoverable,
    mintAuthority,
    freezeAuthority,
    decimals,
    supply,
    creator,
    creationSig,
    creationTime,
    senders,
    tokenName: meta?.name,
    tokenSymbol: meta?.symbol,
  }
}

function App() {
  const [mintInput, setMintInput] = useState('')
  const [rpcUrl, setRpcUrl] = useState(DEFAULT_RPC)
  const [result, setResult] = useState<CheckResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingTrace, setLoadingTrace] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleCheck = async (fullTrace = true) => {
    const raw = extractMint(mintInput)
    if (!isValidMint(raw)) {
      toast.error('Invalid Solana address')
      return
    }

    setError(null)
    setLoading(true)
    if (fullTrace) setLoadingTrace(true)

    try {
      const res = await checkMint(raw, rpcUrl, fullTrace)
      setResult(res)
      if (fullTrace) {
        toast.success(res.isRecoverable ? 'Recoverable SOL found!' : 'Checked successfully')
      }
    } catch (e: any) {
      const msg = e?.message || 'Failed to check mint. Check RPC or address.'
      setError(msg)
      toast.error(msg)
    } finally {
      setLoading(false)
      setLoadingTrace(false)
    }
  }

  const handleQuickCheck = () => handleCheck(false)
  const handleFullCheck = () => handleCheck(true)

  const copy = (text: string, label = 'Copied') => {
    navigator.clipboard.writeText(text)
    toast.success(label)
  }

  const openSolscan = (path: string) => {
    window.open(`https://solscan.io/${path}`, '_blank')
  }

  const loadSample = (sampleMint: string) => {
    setMintInput(sampleMint)
    setResult(null)
    setError(null)
  }

  const clearAll = () => {
    setMintInput('')
    setResult(null)
    setError(null)
  }

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-[#a1a1aa]">
      {/* Top nav */}
      <nav className="border-b border-[#1f1f27] bg-[#0a0a0f]/95 backdrop-blur sticky top-0 z-50">
        <div className="max-w-5xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-[#9945FF] to-[#14F195] flex items-center justify-center">
              <Wallet className="w-5 h-5 text-black" />
            </div>
            <div>
              <div className="font-semibold text-xl tracking-tight text-white">Recoverable SOL</div>
              <div className="text-[10px] text-[#52525b] -mt-1">TOKEN MINT CHECKER</div>
            </div>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <a href={DUNE_URL} target="_blank" className="link flex items-center gap-1 hover:text-white">
              View on Dune <ExternalLink className="w-3.5 h-3.5" />
            </a>
            <span className="text-[#3f3f46]">•</span>
            <button onClick={() => window.open('https://solscan.io', '_blank')} className="link flex items-center gap-1 hover:text-white">
              Solscan
            </button>
          </div>
        </div>
      </nav>

      <div className="max-w-5xl mx-auto px-6 pt-10 pb-24">
        {/* Hero */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#16161F] border border-[#1f1f27] text-xs mb-4">
            <div className="w-2 h-2 rounded-full bg-[#14f195] animate-pulse" />
            Powered by on-chain data • SIMD-0266 p-token
          </div>
          <h1 className="text-5xl font-semibold tracking-tighter text-white mb-3">
            Check if a token mint<br />has recoverable SOL
          </h1>
          <p className="max-w-md mx-auto text-lg">
            Detect excess SOL sent directly to mint accounts. Trace the sender and locate the token dev/creator.
          </p>
          <div className="mt-3 text-xs text-[#52525b]">
            Data from the <a href={DUNE_URL} target="_blank" className="link">Dune recoverable-sol</a> dashboard — now actionable per mint.
          </div>
        </div>

        {/* Input Card */}
        <div className="card p-6 mb-6">
          <div className="flex flex-col gap-3">
            <div>
              <div className="text-sm font-medium mb-2 text-[#e4e4e7]">Token Mint Address</div>
              <div className="flex gap-2">
                <input
                  className="input flex-1"
                  placeholder="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
                  value={mintInput}
                  onChange={(e) => setMintInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleFullCheck() }}
                />
                <button 
                  onClick={() => { 
                    navigator.clipboard.readText().then(t => {
                      const m = extractMint(t)
                      if (isValidMint(m)) setMintInput(m)
                    })
                  }} 
                  className="btn btn-secondary px-4" 
                  title="Paste from clipboard"
                >
                  <Copy className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="flex flex-wrap gap-2 items-center">
              <button 
                onClick={handleFullCheck} 
                disabled={loading || !mintInput.trim()} 
                className="btn btn-primary flex-1 sm:flex-none"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                {loading ? 'Checking...' : 'Full Check (trace + creator)'}
              </button>
              <button 
                onClick={handleQuickCheck} 
                disabled={loading || !mintInput.trim()} 
                className="btn btn-secondary"
              >
                Quick Balance Only
              </button>
              <button onClick={clearAll} className="btn btn-secondary text-sm">Clear</button>
            </div>

            {/* RPC + Samples */}
            <div className="pt-2 border-t border-[#1f1f27] flex flex-col sm:flex-row gap-3 text-sm">
              <div className="flex-1">
                <div className="text-xs mb-1 text-[#52525b]">RPC Endpoint (optional)</div>
                <input 
                  className="input text-xs py-2" 
                  value={rpcUrl} 
                  onChange={e => setRpcUrl(e.target.value)} 
                />
              </div>
              <div>
                <div className="text-xs mb-1 text-[#52525b]">Try examples</div>
                <div className="flex gap-2 flex-wrap">
                  {SAMPLE_MINTS.map((s, idx) => (
                    <button key={idx} onClick={() => loadSample(s.mint)} className="btn btn-secondary text-xs py-1.5 px-3">
                      {s.label}
                    </button>
                  ))}
                  <a href={DUNE_URL} target="_blank" className="btn btn-secondary text-xs py-1.5 px-3 inline-flex items-center gap-1">
                    Browse Dune <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="card p-4 mb-6 border-red-900/60 bg-red-950/30 text-red-400 flex gap-3">
            <AlertCircle className="w-5 h-5 mt-0.5 flex-shrink-0" />
            <div>{error}</div>
          </div>
        )}

        {/* Results */}
        {result && (
          <div className="space-y-6">
            {/* Header / Token Info */}
            <div className="card p-6">
              <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
                <div>
                  <div className="flex items-center gap-3">
                    <div className="text-xs px-2.5 py-1 rounded bg-[#1f1f27] text-[#a1a1aa]">{result.program}</div>
                    {result.tokenSymbol && (
                      <div className="text-xl font-semibold text-white tracking-tight">{result.tokenSymbol}</div>
                    )}
                    {result.tokenName && <div className="text-sm text-[#71717a]">{result.tokenName}</div>}
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <div className="mint-addr text-[#e4e4e7]">{result.mint}</div>
                    <button onClick={() => copy(result.mint, 'Mint copied')} className="copy-btn"><Copy className="w-3.5 h-3.5" /></button>
                    <button onClick={() => openSolscan(`token/${result.mint}`)} className="copy-btn text-[#9945FF]"><ExternalLink className="w-3.5 h-3.5" /></button>
                  </div>
                </div>

                <div>
                  {result.isRecoverable ? (
                    <div className="badge badge-green text-base px-5 py-1.5">RECOVERABLE</div>
                  ) : (
                    <div className="badge badge-gray text-base px-5 py-1.5">NO EXCESS SOL</div>
                  )}
                </div>
              </div>

              {/* SOL Stats */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-6">
                <div className="stat">
                  <div className="text-xs uppercase tracking-[1px] text-[#52525b]">Current SOL in Mint</div>
                  <div className="sol-value mt-1">{result.currentSOL.toFixed(6)}</div>
                </div>
                <div className="stat">
                  <div className="text-xs uppercase tracking-[1px] text-[#52525b]">Rent-Exempt Minimum</div>
                  <div className="text-2xl font-semibold mt-1 text-white">{result.rentSOL.toFixed(6)}</div>
                </div>
                <div className="stat">
                  <div className="text-xs uppercase tracking-[1px] text-[#52525b]">Recoverable Excess</div>
                  <div className={`text-3xl font-bold mt-1 ${result.isRecoverable ? 'text-[#14f195]' : 'text-[#71717a]'}`}>
                    {result.excessSOL.toFixed(6)} SOL
                  </div>
                  {result.isRecoverable && <div className="text-[11px] text-[#14f195]/70 mt-0.5">≈ ${(result.excessSOL * 150).toFixed(0)} at $150/SOL</div>}
                </div>
              </div>

              <div className="flex flex-wrap gap-2 mt-5">
                <button onClick={() => openSolscan(`account/${result.mint}`)} className="btn btn-secondary text-sm">
                  View Account on Solscan <ExternalLink className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => openSolscan(`token/${result.mint}`)} className="btn btn-secondary text-sm">
                  Token Page <ExternalLink className="w-3.5 h-3.5" />
                </button>
                <a href={DUNE_URL} target="_blank" className="btn btn-secondary text-sm inline-flex items-center gap-1.5">
                  View full Dune dashboard <ExternalLink className="w-3.5 h-3.5" />
                </a>
              </div>
            </div>

            {/* Creator / Dev Contact */}
            <div className="card p-6">
              <div className="flex items-center gap-2 mb-4">
                <Wallet className="w-5 h-5 text-[#9945FF]" />
                <h2 className="text-xl text-white">Dev / Creator</h2>
              </div>

              {result.creator ? (
                <div className="space-y-3">
                  <div>
                    <div className="text-xs text-[#71717a] mb-1">Creator Wallet (likely the dev)</div>
                    <div className="flex items-center gap-2 bg-[#0a0a0f] border border-[#1f1f27] rounded-xl p-3 font-mono text-sm break-all">
                      {result.creator}
                      <button onClick={() => copy(result.creator!, 'Creator address copied')} className="copy-btn ml-auto"><Copy className="w-4 h-4" /></button>
                      <button onClick={() => openSolscan(`account/${result.creator}`)} className="copy-btn text-[#9945FF]"><ExternalLink className="w-4 h-4" /></button>
                    </div>
                  </div>

                  {result.creationSig && (
                    <div>
                      <div className="text-xs text-[#71717a] mb-1">Creation Transaction</div>
                      <button onClick={() => openSolscan(`tx/${result.creationSig}`)} className="font-mono text-sm link flex items-center gap-1.5">
                        {shorten(result.creationSig, 8)} <ExternalLink className="w-3.5 h-3.5" />
                      </button>
                      {result.creationTime && <div className="text-xs text-[#52525b] mt-0.5">{result.creationTime}</div>}
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-sm text-[#71717a]">Creator not found (try full trace or older history may be needed).</div>
              )}

              <div className="mt-5 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                <div>
                  <div className="text-xs text-[#52525b]">Mint Authority</div>
                  <div className="font-medium text-white">{result.mintAuthority || 'REVOKED (null)'}</div>
                </div>
                <div>
                  <div className="text-xs text-[#52525b]">Freeze Authority</div>
                  <div className="font-medium text-white">{result.freezeAuthority || 'REVOKED (null)'}</div>
                </div>
                <div>
                  <div className="text-xs text-[#52525b]">Decimals</div>
                  <div className="font-medium text-white">{result.decimals}</div>
                </div>
                <div>
                  <div className="text-xs text-[#52525b]">Supply (raw)</div>
                  <div className="font-medium text-white mono">{result.supply}</div>
                </div>
              </div>
            </div>

            {/* Trace Senders */}
            <div className="card p-6">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <ArrowRight className="w-5 h-5 text-[#14f195]" />
                  <h2 className="text-xl text-white">SOL Senders to Mint</h2>
                </div>
                {result.senders.length === 0 && !loadingTrace && (
                  <div className="text-xs text-[#52525b]">No recent incoming SOL transfers detected in sampled history.</div>
                )}
                {loadingTrace && <div className="text-xs flex items-center gap-1"><Loader2 className="animate-spin w-3 h-3" /> fetching txs…</div>}
              </div>

              {result.senders.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-[#71717a] border-b border-[#1f1f27]">
                        <th className="py-2 pr-3">From</th>
                        <th className="py-2 px-3">Amount</th>
                        <th className="py-2 px-3">Time</th>
                        <th className="py-2 pl-3">Tx</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.senders.map((s, idx) => (
                        <tr key={idx} className="table-row">
                          <td className="py-3 pr-3">
                            <div className="flex items-center gap-2 font-mono">
                              {shorten(s.from, 5)}
                              <button onClick={() => copy(s.from)} className="copy-btn"><Copy className="w-3.5 h-3.5" /></button>
                              <button onClick={() => openSolscan(`account/${s.from}`)} className="copy-btn text-[#9945FF]"><ExternalLink className="w-3.5 h-3.5" /></button>
                            </div>
                          </td>
                          <td className="py-3 px-3 font-mono text-[#14f195] font-medium">+{s.amount.toFixed(6)} SOL</td>
                          <td className="py-3 px-3 text-xs text-[#71717a]">{s.time ? s.time.replace('T', ' ').slice(0, 16) : '—'}</td>
                          <td className="py-3 pl-3">
                            <button onClick={() => openSolscan(`tx/${s.sig}`)} className="font-mono text-xs link">{shorten(s.sig, 6)}</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="text-sm text-[#71717a] py-2">
                  {loading ? 'Scanning transaction history for SOL transfers into the mint...' : 'Run full check to trace senders.'}
                </div>
              )}

              <div className="text-[11px] text-[#52525b] mt-4 flex items-start gap-2">
                <Info className="w-3.5 h-3.5 mt-px" /> 
                Traces are best-effort from recent signatures. Large histories may be truncated due to RPC limits.
              </div>
            </div>

            {/* Recovery Help */}
            {result.isRecoverable && (
              <div className="card p-6 border-[#9945FF]/30 bg-[#16161F]">
                <div className="flex items-center gap-2 mb-3">
                  <CheckCircle className="w-5 h-5 text-[#14f195]" />
                  <h2 className="text-xl text-white">How to Recover</h2>
                </div>
                <ol className="list-decimal list-inside space-y-1.5 text-sm">
                  <li>Use the new <span className="font-mono text-xs bg-black/40 px-1 py-px rounded">withdraw_excess_lamports</span> instruction (p-token / Token-2022).</li>
                  <li>If mint authority is revoked (common), sign the instruction using the original mint keypair (if you still control it).</li>
                  <li>Destination can be any wallet you control.</li>
                  <li>Official docs: <a href="https://solana.com/docs/tokens/advanced/withdraw-excess-lamports" target="_blank" className="link">solana.com/docs</a></li>
                </ol>
                <div className="mt-4 p-3 bg-black/30 rounded text-xs font-mono break-all text-[#a1a1aa]">
                  See also: lost-lamports tools and community recovery scripts. Always test on small amounts first.
                </div>
              </div>
            )}
          </div>
        )}

        {/* Info section when no result */}
        {!result && (
          <div className="mt-10 grid md:grid-cols-3 gap-4 text-sm">
            <div className="card p-5">
              <div className="font-semibold text-white mb-2">What is this?</div>
              <div>People sometimes accidentally send SOL directly to a token mint address. The lamports above rent-exempt become unusable ("bricked").</div>
            </div>
            <div className="card p-5">
              <div className="font-semibold text-white mb-2">SIMD-0266 / p-token</div>
              <div>The recent p-token upgrade added <span className="font-mono text-xs">withdraw_excess_lamports</span> allowing recovery without affecting token supply or balances.</div>
            </div>
            <div className="card p-5">
              <div className="font-semibold text-white mb-2">This tool does</div>
              <ul className="space-y-1 text-[#a1a1aa]">
                <li>• Real-time balance + excess calculation</li>
                <li>• Traces incoming SOL transfers</li>
                <li>• Locates token creator wallet + creation tx</li>
                <li>• Direct links to Solscan and Dune</li>
              </ul>
            </div>
          </div>
        )}

        <div className="text-center text-[10px] text-[#3f3f46] mt-16">
          Client-side only • Uses public RPCs • May hit rate limits on popular mints • Use a private RPC for heavy use
        </div>
      </div>
    </div>
  )
}

export default App
