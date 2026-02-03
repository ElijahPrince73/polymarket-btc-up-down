document.addEventListener('DOMContentLoaded', () => {
    const statusMessage = document.getElementById('status-message');
    const openTradeDiv = document.getElementById('open-trade');
    const ledgerSummaryDiv = document.getElementById('ledger-summary');
    const recentTradesBody = document.getElementById('recent-trades-body');

    // Function to format currency and percentages
    const formatCurrency = (value, decimals = 2) => value.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    const formatPercentage = (value, decimals = 2) => value.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + '%';

    // Function to fetch and display data
    const fetchData = async () => {
        try {
            // Fetch status (live signal, open trade)
            const statusResponse = await fetch('/api/status');
            const statusData = await statusResponse.json();

            // Very simple status text
            if (!statusResponse.ok) {
                throw new Error('status endpoint returned non-200');
            }
            const rt = statusData.runtime;
            if (!statusData?.status?.ok) {
                statusMessage.textContent = 'Not OK';
            } else if (!rt) {
                statusMessage.textContent = `OK (updated ${new Date(statusData.status.updatedAt).toLocaleTimeString()})`;
            } else {
                const up = (rt.modelUp != null) ? Math.round(rt.modelUp * 100) + '%' : 'N/A';
                const down = (rt.modelDown != null) ? Math.round(rt.modelDown * 100) + '%' : 'N/A';
                const btc = (rt.btcPrice != null) ? '$' + Number(rt.btcPrice).toFixed(2) : 'N/A';
                const polyUp = (rt.polyUp != null) ? (Number(rt.polyUp) * 100).toFixed(2) + '¢' : 'N/A';
                const polyDown = (rt.polyDown != null) ? (Number(rt.polyDown) * 100).toFixed(2) + '¢' : 'N/A';
                const pmUrl = rt.marketSlug ? `https://polymarket.com/market/${rt.marketSlug}` : null;
                const linkLine = pmUrl
                    ? `<a href="${pmUrl}" target="_blank" rel="noreferrer">${pmUrl}</a><br/>`
                    : `Polymarket URL: N/A<br/>`;

                statusMessage.innerHTML = linkLine +
                    `Market: ${rt.marketSlug || 'N/A'} | Time left: ${Math.max(0, rt.timeLeftMin).toFixed(2)}m | BTC: ${btc} | Poly UP: ${polyUp} / DOWN: ${polyDown} | ${rt.narrative || 'N/A'} (UP ${up} / DOWN ${down})`;
            }

            if (statusData.openTrade) {
                const t = statusData.openTrade;
                const rt = statusData.runtime;
                const cur = (t.side === 'UP') ? (rt?.polyUp != null ? Number(rt.polyUp) : null) : (rt?.polyDown != null ? Number(rt.polyDown) : null);
                let uPnl = 'N/A';
                if (cur != null && t.entryPrice != null && t.contractSize != null) {
                    const shares = (t.shares != null) ? Number(t.shares) : (t.entryPrice > 0 ? (t.contractSize / t.entryPrice) : null);
                    if (shares != null && Number.isFinite(shares)) {
                        const value = shares * cur;
                        const pnl = value - t.contractSize;
                        uPnl = '$' + pnl.toFixed(2);
                    }
                }

                openTradeDiv.textContent =
                    `ID: ${t.id?.slice(0, 8) || 'N/A'}\n` +
                    `Side: ${t.side}\n` +
                    `Entry: ${(Number(t.entryPrice) * 100).toFixed(2)}¢\n` +
                    `Current: ${cur != null ? (cur * 100).toFixed(2) + '¢' : 'N/A'}\n` +
                    `Unrealized PnL: ${uPnl}\n` +
                    `Contract: $${formatCurrency(t.contractSize)}\n` +
                    `Phase: ${t.entryPhase || 'N/A'}\n` +
                    `Status: ${t.status}`;

                openTradeDiv.classList.remove('closed');
            } else {
                openTradeDiv.textContent = 'No open trade.';
                openTradeDiv.classList.add('closed');
            }

            // Fetch ledger summary
            const summary = statusData.ledgerSummary || { totalTrades: 0, wins: 0, losses: 0, totalPnL: 0, winRate: 0 };
            ledgerSummaryDiv.textContent =
                `Total Trades: ${summary.totalTrades ?? 0}\n` +
                `Wins: ${summary.wins ?? 0}\n` +
                `Losses: ${summary.losses ?? 0}\n` +
                `Total PnL: $${formatCurrency(summary.totalPnL ?? 0)}\n` +
                `Win Rate: ${formatPercentage(summary.winRate ?? 0)}`;

        } catch (error) {
            statusMessage.textContent = 'Error loading status data.';
            openTradeDiv.innerHTML = 'Error loading trade data.';
            ledgerSummaryDiv.innerHTML = 'Error loading summary data.';
            console.error('Error fetching status data:', error);
        }

        // Fetch recent trades
        try {
            const tradesResponse = await fetch('/api/trades');
            const trades = await tradesResponse.json();
            
            if (Array.isArray(trades) && trades.length > 0) {
                // Display only the last N trades for brevity, newest first
                const tradesToDisplay = trades.slice(-10).reverse();

                const rowsHtml = tradesToDisplay.map((trade) => {
                    const entryPx = (trade.entryPrice != null) ? (Number(trade.entryPrice) * 100).toFixed(2) : 'N/A';
                    const exitPx = (trade.exitPrice != null) ? (Number(trade.exitPrice) * 100).toFixed(2) : 'N/A';
                    const entryAt = trade.entryTime ? new Date(trade.entryTime).toLocaleString() : 'N/A';
                    const exitAt = trade.exitTime ? new Date(trade.exitTime).toLocaleString() : 'N/A';
                    const pnl = (trade.pnl != null) ? Number(trade.pnl) : 0;
                    const pnlClass = pnl >= 0 ? 'positive' : 'negative';

                    return `
                      <tr>
                        <td>${entryAt}</td>
                        <td>${exitAt}</td>
                        <td>${trade.side || 'N/A'}</td>
                        <td>${entryPx}</td>
                        <td>${exitPx}</td>
                        <td class="${pnlClass}">${formatCurrency(pnl)}</td>
                        <td>${trade.status || 'N/A'}</td>
                        <td>${trade.exitReason || 'N/A'}</td>
                      </tr>
                    `;
                }).join('');

                recentTradesBody.innerHTML = rowsHtml;
            } else {
                recentTradesBody.innerHTML = '<tr><td colspan="8">No trades recorded yet.</td></tr>';
            }
        } catch (error) {
            recentTradesBody.innerHTML = '<tr><td colspan="8">Error loading recent trades.</td></tr>';
            console.error('Error fetching recent trades:', error);
        }
    };

    // Fetch data every 5 seconds
    fetchData();
    setInterval(fetchData, 5000); 
});
