/**
 * Portfolio UI
 * Renders holdings table, account sidebar, transaction list, dashboard preview
 */

const PortfolioUI = {

    /**
     * Render the main portfolio view
     */
    render(holdings, accounts, transactions, priceCache, options) {
        this.updateHideValuesBtn(PortfolioApp.hideValues);
        this.renderAccountSidebar(accounts, options.currentAccountFilter);

        const filtered = options.currentAccountFilter === 'all'
            ? holdings
            : PortfolioApp.computeHoldings(options.currentAccountFilter);

        this.renderSummaryBar(filtered, options.currentAccountFilter);
        // Grouping is offered once there's something to regroup: any
        // holdings, several accounts (cash-only counts), or the user is
        // already in by-account mode and needs the way back.
        this.renderToggle(options.groupByAccount,
            filtered.length > 0 || accounts.length > 1 || options.groupByAccount);

        const filteredCash = options.currentAccountFilter === 'all'
            ? PortfolioApp.computeTotalCash()
            : PortfolioApp.computeCash(options.currentAccountFilter);

        if (options.groupByAccount) {
            this.renderHoldingsByAccount();
        } else {
            this.renderHoldingsTable(filtered, 'portfolio-holdings', filteredCash);
        }

        this.renderPricesAsOf(priceCache, holdings);
        this.attachEventListeners();
    },

    /**
     * "Prices as of …" freshness caption in the toolbar. Without it the user
     * can't tell live day-change from a three-day-old weekend cache.
     */
    renderPricesAsOf(priceCache, holdings) {
        const el = document.getElementById('portfolio-prices-asof');
        if (!el) return;
        const times = (holdings || [])
            .map(h => priceCache?.[h.ticker]?.updatedAt)
            .filter(Boolean);
        if (!times.length) {
            el.textContent = '';
            el.classList.remove('stale');
            return;
        }
        const oldest = Math.min(...times);
        const d = new Date(oldest);
        const sameDay = d.toDateString() === new Date().toDateString();
        const label = sameDay
            ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
            : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        el.textContent = `Prices as of ${label}`;
        el.classList.toggle('stale', Date.now() - oldest > 24 * 3600 * 1000);
    },

    /**
     * Assistant observations strip — the "Anjadhe's read" cards on the main
     * view. Facts come precomputed from PortfolioApp.computeInsights();
     * clicking a card (or the Ask button) hands the question to the
     * assistant panel via AgentUI.askWithPrompt.
     */
    renderInsights(insights) {
        const container = document.getElementById('portfolio-insights');
        if (!container) return;
        const hasAssistant = typeof AgentUI !== 'undefined';
        if (!insights || !insights.length || !hasAssistant) {
            container.innerHTML = '';
            container.style.display = 'none';
            return;
        }
        container.style.display = '';
        container.innerHTML = `
            <div class="portfolio-insights-header">
                <span class="portfolio-insights-title">Anjadhe's read</span>
                <button id="portfolio-ask-btn" class="portfolio-insights-ask" type="button" title="Open the assistant with your portfolio in context">Ask about my portfolio &rarr;</button>
            </div>
            <div class="portfolio-insights-list">
                ${insights.map((ins, i) => `
                    <button class="portfolio-insight-card" type="button" data-idx="${i}" title="Ask the assistant about this">
                        <span class="portfolio-insight-label">${AppManager.escapeHtml(ins.label)}</span>
                        <span class="portfolio-insight-text">${AppManager.escapeHtml(ins.text)}</span>
                        <span class="portfolio-insight-cta">Ask &rarr;</span>
                    </button>
                `).join('')}
            </div>
        `;

        container.querySelectorAll('.portfolio-insight-card').forEach(card => {
            card.addEventListener('click', () => {
                const ins = insights[parseInt(card.dataset.idx, 10)];
                if (ins) AgentUI.askWithPrompt(ins.prompt);
            });
        });
        document.getElementById('portfolio-ask-btn')?.addEventListener('click', () => {
            AgentUI.askWithPrompt('How is my portfolio doing? Give me a short review grounded in my actual numbers — allocation, cash, and how today went.');
        });
    },

    /**
     * Render the account sidebar
     */
    renderAccountSidebar(accounts, currentFilter) {
        const container = document.getElementById('portfolio-account-list');
        if (!container) return;

        const allHoldings = PortfolioApp.computeHoldings();
        const allStockValue = allHoldings.reduce((s, h) => s + h.currentValue, 0);
        const allCash = PortfolioApp.computeTotalCash();
        const allRealEstate = PortfolioApp.getProperties().reduce((s, p) => s + (p.currentValue || 0), 0);
        const allValue = allStockValue + allCash + allRealEstate;

        let html = `
            <div class="portfolio-filter-item ${currentFilter === 'all' ? 'active' : ''}" data-filter="all">
                <div class="portfolio-filter-name">All Accounts</div>
                <div class="portfolio-filter-value">${this.hv(this.formatMoney(allValue))}</div>
            </div>
        `;

        accounts.forEach(account => {
            const holdings = PortfolioApp.computeHoldings(account.id);
            const stockValue = holdings.reduce((s, h) => s + h.currentValue, 0);
            const cash = PortfolioApp.computeCash(account.id);
            const value = stockValue + cash;
            html += `
                <div class="portfolio-filter-item ${currentFilter === account.id ? 'active' : ''}" data-filter="${account.id}">
                    <div class="portfolio-filter-main">
                        <div class="portfolio-filter-name">${AppManager.escapeHtml(account.name)}</div>
                        <div class="portfolio-filter-type">${this.formatAccountType(account.type)}</div>
                        <div class="portfolio-filter-value">${this.hv(this.formatMoney(value))}</div>
                    </div>
                    <button class="portfolio-filter-open" data-open-account="${account.id}" type="button" tabindex="-1"
                            title="Open account detail" aria-label="Open ${AppManager.escapeHtml(account.name)} detail">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                    </button>
                </div>
            `;
        });

        container.innerHTML = html;

        // Event listeners for filter items. Single-click filters the holdings
        // view to that account; the hover chevron (and double-click, kept as a
        // fallback) opens the account detail page.
        container.querySelectorAll('.portfolio-filter-item').forEach(item => {
            item.addEventListener('click', () => {
                PortfolioApp.currentAccountFilter = item.dataset.filter;
                PortfolioApp.render();
            });
            if (item.dataset.filter !== 'all') {
                item.addEventListener('dblclick', () => {
                    PortfolioApp.openAccountDetail(item.dataset.filter);
                });
            }
        });
        // Chevron affordance — opens detail without also triggering the
        // parent item's filter click.
        container.querySelectorAll('.portfolio-filter-open').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                PortfolioApp.openAccountDetail(btn.dataset.openAccount);
            });
        });
    },

    /**
     * Render the summary bar
     */
    renderSummaryBar(holdings, accountFilter = 'all') {
        const container = document.getElementById('portfolio-summary');
        if (!container) return;

        const accountId = accountFilter === 'all' ? null : accountFilter;
        const summary = PortfolioApp.getSummary(holdings, accountId);

        container.innerHTML = `
            <div class="portfolio-summary-item">
                <span class="portfolio-summary-label">Total Value</span>
                <span class="portfolio-summary-value">${this.hv(this.formatMoney(summary.totalValue))}</span>
            </div>
            ${summary.cash ? `
            <div class="portfolio-summary-item">
                <span class="portfolio-summary-label">Cash</span>
                <span class="portfolio-summary-value">${this.hv(this.formatMoney(summary.cash))}</span>
            </div>
            ` : ''}
            ${summary.realEstateValue ? `
            <div class="portfolio-summary-item">
                <span class="portfolio-summary-label">Real Estate</span>
                <span class="portfolio-summary-value">${this.hv(this.formatMoney(summary.realEstateValue))}</span>
            </div>
            ` : ''}
            <div class="portfolio-summary-item">
                <span class="portfolio-summary-label">Total P&L</span>
                <span class="portfolio-summary-value ${this.hvPlClass(summary.totalPL)}">${this.hv(this.formatPL(summary.totalPL))} (${this.formatPercent(summary.totalPLPercent)})</span>
            </div>
            <div class="portfolio-summary-item">
                <span class="portfolio-summary-label">Day Change</span>
                <span class="portfolio-summary-value ${this.hvPlClass(summary.totalDayChange)}">${this.hv(this.formatPL(summary.totalDayChange))}</span>
            </div>
        `;
    },

    /**
     * Segmented grouping control above the holdings table. Hidden while
     * there are no holdings to group.
     */
    renderToggle(groupByAccount, hasHoldings) {
        const seg = document.getElementById('portfolio-group-seg');
        if (!seg) return;
        seg.style.display = hasHoldings ? '' : 'none';
        seg.querySelectorAll('.portfolio-seg-btn').forEach(btn => {
            const active = (btn.dataset.group === 'account') === !!groupByAccount;
            btn.classList.toggle('is-active', active);
            btn.setAttribute('aria-selected', String(active));
        });
    },

    /**
     * Build a sortable table header
     */
    buildSortableHeader(label, col, isNum) {
        const isActive = PortfolioApp.sortColumn === col;
        const arrow = isActive ? (PortfolioApp.sortDirection === 'asc' ? '▲' : '▼') : '▲';
        const classes = ['sortable-th'];
        if (isNum) classes.push('num');
        if (isActive) classes.push('sort-active');
        return `<th class="${classes.join(' ')}" data-col="${col}">${label}<span class="sort-arrow">${arrow}</span></th>`;
    },

    buildPropertySortableHeader(label, col, isNum) {
        const isActive = PortfolioApp.propertySortColumn === col;
        const arrow = isActive ? (PortfolioApp.propertySortDirection === 'asc' ? '▲' : '▼') : '▲';
        const classes = ['sortable-th'];
        if (isNum) classes.push('num');
        if (isActive) classes.push('sort-active');
        return `<th class="${classes.join(' ')}" data-property-col="${col}">${label}<span class="sort-arrow">${arrow}</span></th>`;
    },

    /**
     * Render flat holdings table
     */
    renderHoldingsTable(holdings, containerId = 'portfolio-holdings', cashOverride = null) {
        const container = document.getElementById(containerId);
        if (!container) return;

        if (holdings.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <span class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="20" x2="20" y2="20"/><line x1="7" y1="20" x2="7" y2="12"/><line x1="12" y1="20" x2="12" y2="7"/><line x1="17" y1="20" x2="17" y2="10"/></svg></span>
                    <h3>No holdings yet</h3>
                    <p>Add a transaction to get started</p>
                </div>
            `;
            return;
        }

        const sorted = PortfolioApp.sortHoldings(holdings);
        const cash = cashOverride !== null ? cashOverride : PortfolioApp.computeTotalCash();
        const totalValue = holdings.reduce((s, h) => s + h.currentValue, 0) + cash;

        container.innerHTML = `
            <table class="portfolio-table">
                <thead>
                    <tr>
                        ${this.buildSortableHeader('Ticker', 'ticker', false)}
                        ${this.buildSortableHeader('Shares', 'totalShares', true)}
                        ${this.buildSortableHeader('Avg Cost', 'avgCostBasis', true)}
                        ${this.buildSortableHeader('Price', 'currentPrice', true)}
                        ${this.buildSortableHeader('Value', 'currentValue', true)}
                        <th class="num">Weight</th>
                        ${this.buildSortableHeader('P&L', 'profitLoss', true)}
                        ${this.buildSortableHeader('Day', 'dayChange', true)}
                    </tr>
                </thead>
                <tbody>
                    ${sorted.map(h => {
                        const weight = totalValue > 0 ? (h.currentValue / totalValue) * 100 : 0;
                        return `
                        <tr class="portfolio-row" data-ticker="${h.ticker}">
                            <td class="portfolio-ticker">${h.ticker}</td>
                            <td class="num">${this.formatShares(h.totalShares)}</td>
                            <td class="num">${this.formatMoney(h.avgCostBasis)}</td>
                            <td class="num">${h.currentPrice ? this.formatMoney(h.currentPrice) : '—'}</td>
                            <td class="num">${h.currentPrice ? this.hv(this.formatMoney(h.currentValue)) : '—'}</td>
                            <td class="num">${h.currentPrice ? this.formatPercent(weight) : '—'}</td>
                            <td class="num ${this.hvPlClass(h.profitLoss)}">${h.currentPrice ? `${this.hv(this.formatPL(h.profitLoss))} (${this.formatPercent(h.profitLossPercent)})` : '—'}</td>
                            <td class="num ${this.hvPlClass(h.dayChange)}">${h.currentPrice ? `${this.hv(this.formatPL(h.dayChange))} (${this.formatPercent(h.dayChangePercent)})` : '—'}</td>
                        </tr>
                        `;
                    }).join('')}
                    ${this.renderCashRow(cash, totalValue)}
                </tbody>
            </table>
        `;

        // Sort click delegation on thead
        const thead = container.querySelector('thead');
        if (thead) {
            thead.addEventListener('click', (e) => {
                const th = e.target.closest('[data-col]');
                if (th) PortfolioApp.setSortColumn(th.dataset.col);
            });
        }

        // Row click to open ticker or cash detail
        container.querySelectorAll('.portfolio-row').forEach(row => {
            row.addEventListener('click', () => {
                if (row.dataset.cash) {
                    PortfolioApp.openCashDetail();
                } else {
                    PortfolioApp.openTickerDetail(row.dataset.ticker);
                }
            });
        });
    },

    /**
     * Render holdings grouped by account
     */
    renderHoldingsByAccount() {
        const container = document.getElementById('portfolio-holdings');
        if (!container) return;

        const groups = PortfolioApp.computeHoldingsByAccount();

        if (groups.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <span class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="20" x2="20" y2="20"/><line x1="7" y1="20" x2="7" y2="12"/><line x1="12" y1="20" x2="12" y2="7"/><line x1="17" y1="20" x2="17" y2="10"/></svg></span>
                    <h3>No holdings yet</h3>
                    <p>Add a transaction to get started</p>
                </div>
            `;
            return;
        }

        container.innerHTML = groups.map(g => {
            const summary = PortfolioApp.getSummary(g.holdings, g.account.id);
            const sorted = PortfolioApp.sortHoldings(g.holdings);
            const acctTotal = summary.totalValue;
            return `
                <div class="portfolio-account-group">
                    <div class="portfolio-account-group-header" data-account-id="${g.account.id}">
                        <h3>${AppManager.escapeHtml(g.account.name)} <span class="portfolio-account-type-badge">${this.formatAccountType(g.account.type)}</span></h3>
                        <span class="portfolio-account-group-value">${this.hv(this.formatMoney(summary.totalValue))} <span class="${this.hvPlClass(summary.totalPL)}">${this.hv(this.formatPL(summary.totalPL))}</span></span>
                    </div>
                    <table class="portfolio-table">
                        <thead>
                            <tr>
                                ${this.buildSortableHeader('Ticker', 'ticker', false)}
                                ${this.buildSortableHeader('Shares', 'totalShares', true)}
                                ${this.buildSortableHeader('Avg Cost', 'avgCostBasis', true)}
                                ${this.buildSortableHeader('Price', 'currentPrice', true)}
                                ${this.buildSortableHeader('Value', 'currentValue', true)}
                                <th class="num">Weight</th>
                                ${this.buildSortableHeader('P&L', 'profitLoss', true)}
                                ${this.buildSortableHeader('Day', 'dayChange', true)}
                            </tr>
                        </thead>
                        <tbody>
                            ${sorted.map(h => {
                                const weight = acctTotal > 0 ? (h.currentValue / acctTotal) * 100 : 0;
                                return `
                                <tr class="portfolio-row" data-ticker="${h.ticker}">
                                    <td class="portfolio-ticker">${h.ticker}</td>
                                    <td class="num">${this.formatShares(h.totalShares)}</td>
                                    <td class="num">${this.formatMoney(h.avgCostBasis)}</td>
                                    <td class="num">${h.currentPrice ? this.formatMoney(h.currentPrice) : '—'}</td>
                                    <td class="num">${h.currentPrice ? this.hv(this.formatMoney(h.currentValue)) : '—'}</td>
                                    <td class="num">${h.currentPrice ? this.formatPercent(weight) : '—'}</td>
                                    <td class="num ${this.hvPlClass(h.profitLoss)}">${h.currentPrice ? `${this.hv(this.formatPL(h.profitLoss))} (${this.formatPercent(h.profitLossPercent)})` : '—'}</td>
                                    <td class="num ${this.hvPlClass(h.dayChange)}">${h.currentPrice ? `${this.hv(this.formatPL(h.dayChange))} (${this.formatPercent(h.dayChangePercent)})` : '—'}</td>
                                </tr>
                                `;
                            }).join('')}
                            ${this.renderCashRow(g.cash, acctTotal)}
                        </tbody>
                    </table>
                </div>
            `;
        }).join('');

        // Click group header to open account detail
        container.querySelectorAll('.portfolio-account-group-header').forEach(header => {
            header.addEventListener('click', () => {
                PortfolioApp.openAccountDetail(header.dataset.accountId);
            });
        });

        // Sort click delegation on all theads
        container.querySelectorAll('thead').forEach(thead => {
            thead.addEventListener('click', (e) => {
                const th = e.target.closest('[data-col]');
                if (th) PortfolioApp.setSortColumn(th.dataset.col);
            });
        });

        // Row click to open ticker or cash detail
        container.querySelectorAll('.portfolio-row').forEach(row => {
            row.addEventListener('click', () => {
                if (row.dataset.cash) {
                    PortfolioApp.openCashDetail();
                } else {
                    PortfolioApp.openTickerDetail(row.dataset.ticker);
                }
            });
        });
    },

    /**
     * Attach event listeners to dynamic elements
     */
    attachEventListeners() {
        // Nothing extra needed currently — sidebar listeners are in renderAccountSidebar
    },

    // ---- Account Detail View ----

    renderAccountDetail(account, holdings, transactions, currentView, accountHistory, hideValues) {
        const nameEl = document.getElementById('portfolio-account-name');
        if (nameEl) nameEl.textContent = account.name;

        const typeEl = document.getElementById('portfolio-account-type-display');
        if (typeEl) typeEl.textContent = this.formatAccountType(account.type);

        // Summary
        const summaryEl = document.getElementById('portfolio-account-summary');
        if (summaryEl) {
            const summary = PortfolioApp.getSummary(holdings, account.id);
            summaryEl.innerHTML = `
                <div class="portfolio-summary-item">
                    <span class="portfolio-summary-label">Value</span>
                    <span class="portfolio-summary-value">${this.hv(this.formatMoney(summary.totalValue))}</span>
                </div>
                ${summary.cash ? `
                <div class="portfolio-summary-item">
                    <span class="portfolio-summary-label">Cash</span>
                    <span class="portfolio-summary-value">${this.hv(this.formatMoney(summary.cash))}</span>
                </div>
                ` : ''}
                <div class="portfolio-summary-item">
                    <span class="portfolio-summary-label">P&L</span>
                    <span class="portfolio-summary-value ${this.hvPlClass(summary.totalPL)}">${this.hv(this.formatPL(summary.totalPL))} (${this.formatPercent(summary.totalPLPercent)})</span>
                </div>
                <div class="portfolio-summary-item">
                    <span class="portfolio-summary-label">Day</span>
                    <span class="portfolio-summary-value ${this.hvPlClass(summary.totalDayChange)}">${this.hv(this.formatPL(summary.totalDayChange))}</span>
                </div>
            `;
        }

        // Tabs
        const holdingsTab = document.getElementById('portfolio-account-holdings-tab');
        const txnsTab = document.getElementById('portfolio-account-txns-tab');
        if (holdingsTab && txnsTab) {
            holdingsTab.className = `portfolio-tab ${currentView === 'holdings' ? 'active' : ''}`;
            txnsTab.className = `portfolio-tab ${currentView === 'transactions' ? 'active' : ''}`;

            const newHoldingsTab = holdingsTab.cloneNode(true);
            holdingsTab.parentNode.replaceChild(newHoldingsTab, holdingsTab);
            newHoldingsTab.addEventListener('click', () => PortfolioApp.switchAccountTab('holdings'));

            const newTxnsTab = txnsTab.cloneNode(true);
            txnsTab.parentNode.replaceChild(newTxnsTab, txnsTab);
            newTxnsTab.addEventListener('click', () => PortfolioApp.switchAccountTab('transactions'));
        }

        // Content
        const contentEl = document.getElementById('portfolio-account-content');
        if (!contentEl) return;

        if (currentView === 'holdings') {
            contentEl.innerHTML = '<div id="portfolio-account-holdings"></div>';
            this.renderHoldingsTable(holdings, 'portfolio-account-holdings', PortfolioApp.computeCash(account.id));
        } else {
            this.renderTransactionList(transactions, contentEl);
        }

        // Add transaction button for account view
        const addBtn = document.getElementById('portfolio-account-add-txn-btn');
        if (addBtn) {
            const newBtn = addBtn.cloneNode(true);
            addBtn.parentNode.replaceChild(newBtn, addBtn);
            newBtn.addEventListener('click', () => PortfolioApp.openTransactionEditor());
        }

        // Account value history chart
        if (accountHistory && accountHistory.length >= 2) {
            this.renderDetailChart('portfolio-account-chart', accountHistory, 'value', hideValues);
        } else {
            const chartEl = document.getElementById('portfolio-account-chart');
            if (chartEl) chartEl.innerHTML = '';
        }

        // Per-account strategy notes (cross-app links to Notes).
        this.renderNotesSection('portfolio-account-notes', account.id,
            () => PortfolioApp.renderAccountDetail());
    },

    /**
     * Strategy notes — cross-app note links (LinkManager) for the whole
     * portfolio (itemId 'overview') or a single account. The strategies
     * themselves live in Notes; this section lists them, opens them on
     * click, and offers "+ New Note" (pre-linked) / "+ Link Note" (picker).
     */
    renderNotesSection(containerId, itemId, onChanged) {
        const el = document.getElementById(containerId);
        if (!el || typeof LinkedItemsUI === 'undefined') return;
        el.innerHTML = LinkedItemsUI.renderAll('portfolio', itemId, {
            sections: [
                { targetApp: 'notes', label: 'Strategy Notes', buttonLabel: '+ Link Note' }
            ]
        });
        LinkedItemsUI.attachListeners(el, onChanged);
    },

    /**
     * Render transaction list
     */
    renderTransactionList(transactions, container) {
        if (transactions.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <span class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg></span>
                    <h3>No transactions yet</h3>
                    <p>Add a buy or sell transaction</p>
                </div>
            `;
            return;
        }

        container.innerHTML = `
            <div class="portfolio-txn-list">
                ${transactions.map(txn => {
                    const account = PortfolioApp.accounts.find(a => a.id === txn.accountId);
                    return `
                        <div class="portfolio-txn-item" data-txn-id="${txn.id}">
                            <div class="portfolio-txn-left">
                                <span class="portfolio-txn-type ${txn.type}">${txn.type.toUpperCase()}</span>
                                <span class="portfolio-txn-ticker">${txn.ticker}</span>
                                <span class="portfolio-txn-detail">${this.formatShares(txn.quantity)} @ ${this.formatMoney(txn.pricePerShare)}</span>
                            </div>
                            <div class="portfolio-txn-right">
                                <span class="portfolio-txn-total">${this.hv(this.formatMoney(txn.quantity * txn.pricePerShare))}</span>
                                <span class="portfolio-txn-date">${this.formatDate(txn.date)}</span>
                                ${account ? `<span class="portfolio-txn-account">${AppManager.escapeHtml(account.name)}</span>` : ''}
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        `;

        // Click to edit
        container.querySelectorAll('.portfolio-txn-item').forEach(item => {
            item.addEventListener('click', () => {
                PortfolioApp.openTransactionEditor(item.dataset.txnId);
            });
        });
    },

    // ---- Transaction Editor ----

    renderTransactionEditor(transaction, accounts, defaultAccountId) {
        const now = new Date();
        const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

        // Type toggle
        const buyRadio = document.getElementById('txn-type-buy');
        const sellRadio = document.getElementById('txn-type-sell');
        if (buyRadio && sellRadio) {
            if (transaction?.type === 'sell') {
                sellRadio.checked = true;
            } else {
                buyRadio.checked = true;
            }
        }

        // Account select
        const accountSelect = document.getElementById('txn-account-select');
        if (accountSelect) {
            accountSelect.innerHTML = `
                <option value="">Select account...</option>
                ${accounts.map(a => `<option value="${a.id}" ${(transaction?.accountId || defaultAccountId) === a.id ? 'selected' : ''}>${AppManager.escapeHtml(a.name)}</option>`).join('')}
            `;
        }

        // Fields
        const fields = {
            'txn-ticker-input': transaction?.ticker || '',
            'txn-quantity-input': transaction?.quantity || '',
            'txn-price-input': transaction?.pricePerShare || '',
            'txn-date-input': transaction?.date || today,
            'txn-notes-input': transaction?.notes || ''
        };

        Object.entries(fields).forEach(([id, value]) => {
            const el = document.getElementById(id);
            if (el) el.value = value;
        });

        // Title
        const titleEl = document.getElementById('portfolio-transaction-title');
        if (titleEl) titleEl.textContent = transaction ? 'Edit Transaction' : 'New Transaction';

        // Live preview wiring. Property-assigned handlers (not
        // addEventListener) so re-opening the editor doesn't stack
        // duplicates — same pattern as the Customize-apps list.
        const tickerInput = document.getElementById('txn-ticker-input');
        if (tickerInput) {
            tickerInput.oninput = () => {
                // Tickers are uppercase — fix as the user types.
                const pos = tickerInput.selectionStart;
                tickerInput.value = tickerInput.value.toUpperCase();
                tickerInput.setSelectionRange(pos, pos);
                this.updateTxnPreview();
            };
        }
        ['txn-account-select', 'txn-quantity-input', 'txn-price-input'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.oninput = () => this.updateTxnPreview();
        });
        document.querySelectorAll('input[name="txn-type"]').forEach(r => {
            r.onchange = () => this.updateTxnPreview();
        });

        const useBtn = document.getElementById('txn-use-price-btn');
        if (useBtn) {
            useBtn.onclick = async () => {
                const ticker = (tickerInput?.value || '').trim().toUpperCase();
                if (!ticker) return;
                useBtn.disabled = true;
                useBtn.textContent = 'Fetching…';
                const quote = await PriceFetcher.fetchSingle(ticker);
                useBtn.disabled = false;
                useBtn.textContent = 'Use current price';
                if (quote?.price) {
                    const priceInput = document.getElementById('txn-price-input');
                    if (priceInput) priceInput.value = quote.price.toFixed(2);
                    this.updateTxnPreview();
                } else {
                    UIUtils.showToast(`Couldn't fetch a price for ${ticker}`, 'error');
                }
            };
        }

        this.updateTxnPreview();
    },

    /**
     * Transaction editor live math: order total, cash-after in the chosen
     * account (accounting for the reversal of the transaction being
     * edited), and how many shares are on hand when selling.
     */
    updateTxnPreview() {
        const type = document.querySelector('input[name="txn-type"]:checked')?.value || 'buy';
        const accountId = document.getElementById('txn-account-select')?.value || '';
        const ticker = (document.getElementById('txn-ticker-input')?.value || '').trim().toUpperCase();
        const qty = parseFloat(document.getElementById('txn-quantity-input')?.value);
        const price = parseFloat(document.getElementById('txn-price-input')?.value);

        const useBtn = document.getElementById('txn-use-price-btn');
        if (useBtn) useBtn.hidden = !ticker;

        const hint = document.getElementById('txn-owned-hint');
        if (hint) {
            if (type === 'sell' && ticker && accountId) {
                const holding = PortfolioApp.computeHoldings(accountId).find(h => h.ticker === ticker);
                const owned = holding?.totalShares || 0;
                hint.hidden = false;
                hint.textContent = owned > 0
                    ? `You hold ${owned} share${owned === 1 ? '' : 's'} of ${ticker} in this account.`
                    : `No ${ticker} shares in this account.`;
            } else {
                hint.hidden = true;
            }
        }

        const summary = document.getElementById('txn-summary');
        if (!summary) return;
        if (!(qty > 0) || !(price > 0)) {
            summary.hidden = true;
            return;
        }
        const total = qty * price;
        let cashLine = '';
        if (accountId) {
            let cash = PortfolioApp.computeCash(accountId);
            // Editing: the old transaction's cash effect gets reversed on
            // save, so fold that reversal into the preview.
            const old = PortfolioApp.editingTransaction;
            if (old && old.accountId === accountId) {
                cash += (old.type === 'buy' ? 1 : -1) * old.quantity * old.pricePerShare;
            }
            const after = type === 'buy' ? cash - total : cash + total;
            const acct = PortfolioApp.getAccounts().find(a => a.id === accountId);
            const afterStr = this.formatMoney(after);
            cashLine = ` &middot; Cash in ${AppManager.escapeHtml(acct?.name || 'account')} after: ` +
                (after < 0 ? `<span class="txn-cash-warn">${afterStr}</span>` : afterStr);
        }
        summary.hidden = false;
        summary.innerHTML = `Total: <strong>${this.formatMoney(total)}</strong>${cashLine}`;
    },

    // ---- Ticker Detail View ----

    renderTickerDetail(ticker, holding, byAccount, companyInfo, priceData, tickerHistory, hideValues) {
        const container = document.getElementById('portfolio-ticker-content');
        if (!container) return;

        const allHoldings = PortfolioApp.computeHoldings();
        const portfolioTotal = allHoldings.reduce((s, h) => s + h.currentValue, 0) + PortfolioApp.computeTotalCash();
        let html = '';

        // Company info card
        if (!companyInfo) {
            html += '<div class="portfolio-company-loading">Loading company info...</div>';
        } else if (companyInfo.error) {
            html += '<div class="portfolio-company-loading">Company info unavailable</div>';
        } else {
            html += '<div class="portfolio-company-card">';
            html += `<h3 class="portfolio-company-name">${AppManager.escapeHtml(companyInfo.name)}</h3>`;

            const metaParts = [];
            if (companyInfo.sector) metaParts.push(`<span>${AppManager.escapeHtml(companyInfo.sector)}</span>`);
            if (companyInfo.industry) metaParts.push(`<span>${AppManager.escapeHtml(companyInfo.industry)}</span>`);
            if (companyInfo.country) metaParts.push(`<span>${AppManager.escapeHtml(companyInfo.country)}</span>`);
            if (companyInfo.employees) metaParts.push(`<span>${companyInfo.employees.toLocaleString()} employees</span>`);
            if (metaParts.length > 0) {
                html += `<div class="portfolio-company-meta">${metaParts.join('')}</div>`;
            }

            if (companyInfo.description) {
                html += `<p class="portfolio-company-description">${AppManager.escapeHtml(companyInfo.description)}</p>`;
            }
            if (companyInfo.website) {
                // M11: scheme-validate the remote (Yahoo) website URL before it
                // becomes an href; rel=noopener since target=_blank.
                const site = UIUtils.safeHref(companyInfo.website);
                html += `<a class="portfolio-company-website" href="${AppManager.escapeHtml(site)}" target="_blank" rel="noopener noreferrer">${AppManager.escapeHtml(companyInfo.website)}</a>`;
            }
            html += '</div>';
        }

        // Price summary bar
        if (holding) {
            html += `
                <div class="portfolio-summary">
                    <div class="portfolio-summary-item">
                        <span class="portfolio-summary-label">Price</span>
                        <span class="portfolio-summary-value">${holding.currentPrice ? this.formatMoney(holding.currentPrice) : '—'}</span>
                    </div>
                    <div class="portfolio-summary-item">
                        <span class="portfolio-summary-label">Total Value</span>
                        <span class="portfolio-summary-value">${this.hv(this.formatMoney(holding.currentValue))}</span>
                    </div>
                    <div class="portfolio-summary-item">
                        <span class="portfolio-summary-label">P&L</span>
                        <span class="portfolio-summary-value ${this.hvPlClass(holding.profitLoss)}">${this.hv(this.formatPL(holding.profitLoss))} (${this.formatPercent(holding.profitLossPercent)})</span>
                    </div>
                    <div class="portfolio-summary-item">
                        <span class="portfolio-summary-label">Day Change</span>
                        <span class="portfolio-summary-value ${this.hvPlClass(holding.dayChange)}">${this.hv(this.formatPL(holding.dayChange))} (${this.formatPercent(holding.dayChangePercent)})</span>
                    </div>
                    <div class="portfolio-summary-item">
                        <span class="portfolio-summary-label">Portfolio Weight</span>
                        <span class="portfolio-summary-value">${portfolioTotal > 0 ? this.formatPercent((holding.currentValue / portfolioTotal) * 100) : '—'}</span>
                    </div>
                </div>
            `;
        }

        // History charts
        if (tickerHistory && tickerHistory.length >= 2) {
            html += '<h4 class="portfolio-ticker-section-title">Price History</h4>';
            html += '<div id="portfolio-ticker-price-chart" class="portfolio-detail-chart"></div>';
            html += '<h4 class="portfolio-ticker-section-title">Value History</h4>';
            html += '<div id="portfolio-ticker-value-chart" class="portfolio-detail-chart"></div>';
        }

        // Holdings by account table
        if (byAccount.length > 0) {
            html += '<h4 class="portfolio-ticker-section-title">Holdings by Account</h4>';
            html += `
                <table class="portfolio-table">
                    <thead>
                        <tr>
                            <th>Account</th>
                            <th class="num">Type</th>
                            <th class="num">Shares</th>
                            <th class="num">Avg Cost</th>
                            <th class="num">Cost Basis</th>
                            <th class="num">Value</th>
                            <th class="num">Acct Weight</th>
                            <th class="num">P&L</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${byAccount.map(h => {
                            const acctSummary = PortfolioApp.getSummary(PortfolioApp.computeHoldings(h.account.id), h.account.id);
                            const acctWeight = acctSummary.totalValue > 0 ? (h.currentValue / acctSummary.totalValue) * 100 : 0;
                            return `
                            <tr>
                                <td>${AppManager.escapeHtml(h.account.name)}</td>
                                <td class="num">${this.formatAccountType(h.account.type)}</td>
                                <td class="num">${this.formatShares(h.totalShares)}</td>
                                <td class="num">${this.formatMoney(h.avgCostBasis)}</td>
                                <td class="num">${this.hv(this.formatMoney(h.costBasis))}</td>
                                <td class="num">${h.currentPrice ? this.hv(this.formatMoney(h.currentValue)) : '—'}</td>
                                <td class="num">${h.currentPrice ? this.formatPercent(acctWeight) : '—'}</td>
                                <td class="num ${this.hvPlClass(h.profitLoss)}">${h.currentPrice ? `${this.hv(this.formatPL(h.profitLoss))} (${this.formatPercent(h.profitLossPercent)})` : '—'}</td>
                            </tr>
                            `;
                        }).join('')}
                    </tbody>
                </table>
            `;
        }

        container.innerHTML = html;

        // Render charts after DOM insertion
        if (tickerHistory && tickerHistory.length >= 2) {
            this.renderDetailChart('portfolio-ticker-price-chart', tickerHistory, 'price', hideValues);
            this.renderDetailChart('portfolio-ticker-value-chart', tickerHistory, 'value', hideValues);
        }
    },

    /**
     * Render a cash line item row for the holdings table
     */
    renderCashRow(cash, totalValue) {
        if (!cash) return '';
        const weight = totalValue > 0 ? (cash / totalValue) * 100 : 0;
        return `
            <tr class="portfolio-cash-row portfolio-row" data-cash="true">
                <td class="portfolio-ticker">Cash</td>
                <td class="num">—</td>
                <td class="num">—</td>
                <td class="num">—</td>
                <td class="num">${this.hv(this.formatMoney(cash))}</td>
                <td class="num">${this.formatPercent(weight)}</td>
                <td class="num">—</td>
                <td class="num">—</td>
            </tr>
        `;
    },

    buildCashSortableHeader(label, col, isNum) {
        const isActive = PortfolioApp.cashSortColumn === col;
        const arrow = isActive ? (PortfolioApp.cashSortDirection === 'asc' ? '▲' : '▼') : '▲';
        const classes = ['sortable-th'];
        if (isNum) classes.push('num');
        if (isActive) classes.push('sort-active');
        return `<th class="${classes.join(' ')}" data-cash-col="${col}">${label}<span class="sort-arrow">${arrow}</span></th>`;
    },

    renderCashDetail(accounts) {
        const container = document.getElementById('portfolio-ticker-content');
        if (!container) return;

        const accountsWithCash = accounts
            .map(a => ({ account: a, name: a.name, type: a.type, cash: PortfolioApp.computeCash(a.id) }))
            .filter(a => a.cash !== 0);

        const col = PortfolioApp.cashSortColumn;
        const dir = PortfolioApp.cashSortDirection === 'asc' ? 1 : -1;
        accountsWithCash.sort((a, b) => {
            if (col === 'name' || col === 'type') {
                return dir * (a[col] || '').localeCompare(b[col] || '');
            }
            return dir * ((a[col] || 0) - (b[col] || 0));
        });

        const totalCash = accountsWithCash.reduce((sum, a) => sum + a.cash, 0);

        let html = `
            <div class="portfolio-summary">
                <div class="portfolio-summary-item">
                    <span class="portfolio-summary-label">Total Cash</span>
                    <span class="portfolio-summary-value">${this.hv(this.formatMoney(totalCash))}</span>
                </div>
            </div>
        `;

        if (accountsWithCash.length > 0) {
            html += '<h4 class="portfolio-ticker-section-title">Cash by Account</h4>';
            html += `
                <table class="portfolio-table">
                    <thead>
                        <tr>
                            ${this.buildCashSortableHeader('Account', 'name', false)}
                            ${this.buildCashSortableHeader('Type', 'type', true)}
                            ${this.buildCashSortableHeader('Balance', 'cash', true)}
                        </tr>
                    </thead>
                    <tbody>
                        ${accountsWithCash.map(a => `
                            <tr>
                                <td>${AppManager.escapeHtml(a.account.name)}</td>
                                <td class="num">${this.formatAccountType(a.account.type)}</td>
                                <td class="num">${this.hv(this.formatMoney(a.cash))}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            `;
        } else {
            html += `
                <div class="empty-state">
                    <h3>No cash balances</h3>
                    <p>Add cash to an account to see it here</p>
                </div>
            `;
        }

        container.innerHTML = html;

        // Sort click on cash thead
        const thead = container.querySelector('thead');
        if (thead) {
            thead.addEventListener('click', (e) => {
                const th = e.target.closest('[data-cash-col]');
                if (th) PortfolioApp.setCashSortColumn(th.dataset.cashCol);
            });
        }
    },

    // ---- Properties Section ----

    renderPropertiesSection(properties) {
        const container = document.getElementById('portfolio-holdings');
        if (!container || !properties || properties.length === 0) return;

        const sorted = PortfolioApp.sortProperties(properties);

        let html = `
            <div class="portfolio-properties-section">
                <h4 class="portfolio-ticker-section-title">Real Estate</h4>
                <table class="portfolio-table">
                    <thead>
                        <tr>
                            ${this.buildPropertySortableHeader('Name', 'name', false)}
                            ${this.buildPropertySortableHeader('Address', 'address', false)}
                            ${this.buildPropertySortableHeader('Value', 'currentValue', true)}
                            ${this.buildPropertySortableHeader('Purchase Price', 'purchasePrice', true)}
                            ${this.buildPropertySortableHeader('P&L', 'profitLoss', true)}
                        </tr>
                    </thead>
                    <tbody>
                        ${sorted.map(p => {
                            const pl = (p.currentValue || 0) - (p.purchasePrice || 0);
                            const plPct = p.purchasePrice > 0 ? (pl / p.purchasePrice) * 100 : 0;
                            const addr = p.address || '';
                            const truncAddr = addr.length > 30 ? addr.substring(0, 30) + '...' : addr;
                            return `
                                <tr class="portfolio-row portfolio-property-row" data-property-id="${p.id}">
                                    <td class="portfolio-ticker">${AppManager.escapeHtml(p.name)}</td>
                                    <td>${AppManager.escapeHtml(truncAddr)}</td>
                                    <td class="num">${this.hv(this.formatMoney(p.currentValue))}</td>
                                    <td class="num">${this.hv(this.formatMoney(p.purchasePrice))}</td>
                                    <td class="num ${this.hvPlClass(pl)}">${p.purchasePrice ? `${this.hv(this.formatPL(pl))} (${this.formatPercent(plPct)})` : '—'}</td>
                                </tr>
                            `;
                        }).join('')}
                    </tbody>
                </table>
            </div>
        `;

        container.insertAdjacentHTML('beforeend', html);

        // Sort click on property thead
        const propThead = container.querySelector('.portfolio-properties-section thead');
        if (propThead) {
            propThead.addEventListener('click', (e) => {
                const th = e.target.closest('[data-property-col]');
                if (th) PortfolioApp.setPropertySortColumn(th.dataset.propertyCol);
            });
        }

        // Click row to open property detail
        container.querySelectorAll('.portfolio-property-row').forEach(row => {
            row.addEventListener('click', () => {
                PortfolioApp.openPropertyDetail(row.dataset.propertyId);
            });
        });
    },

    // ---- Property Detail View ----

    renderPropertyDetail(property) {
        const container = document.getElementById('portfolio-property-content');
        if (!container) return;

        const pl = (property.currentValue || 0) - (property.purchasePrice || 0);
        const plPct = property.purchasePrice > 0 ? (pl / property.purchasePrice) * 100 : 0;

        let html = `
            <div class="portfolio-company-card">
                ${property.address ? `<p class="portfolio-company-meta">${AppManager.escapeHtml(property.address)}</p>` : ''}
            </div>

            <div class="portfolio-summary">
                <div class="portfolio-summary-item">
                    <span class="portfolio-summary-label">Current Value</span>
                    <span class="portfolio-summary-value">${this.hv(this.formatMoney(property.currentValue))}</span>
                </div>
                <div class="portfolio-summary-item">
                    <span class="portfolio-summary-label">Purchase Price</span>
                    <span class="portfolio-summary-value">${this.hv(this.formatMoney(property.purchasePrice))}</span>
                </div>
                ${property.purchasePrice ? `
                <div class="portfolio-summary-item">
                    <span class="portfolio-summary-label">P&L</span>
                    <span class="portfolio-summary-value ${this.hvPlClass(pl)}">${this.hv(this.formatPL(pl))} (${this.formatPercent(plPct)})</span>
                </div>
                ` : ''}
                ${property.purchaseDate ? `
                <div class="portfolio-summary-item">
                    <span class="portfolio-summary-label">Purchase Date</span>
                    <span class="portfolio-summary-value">${this.formatDate(property.purchaseDate)}</span>
                </div>
                ` : ''}
            </div>

            ${property.notes ? `
            <div class="portfolio-company-card">
                <h4 class="portfolio-ticker-section-title" style="margin-top: 0;">Notes</h4>
                <p style="font-size: var(--text-sm); color: var(--color-text-secondary); margin: 0; white-space: pre-wrap;">${AppManager.escapeHtml(property.notes)}</p>
            </div>
            ` : ''}

            <div class="portfolio-toolbar" style="margin-top: var(--space-lg);">
                <button class="secondary-btn" id="portfolio-property-edit-btn">Edit</button>
                <button class="secondary-btn" id="portfolio-property-delete-btn">Delete</button>
            </div>
        `;

        container.innerHTML = html;

        // Wire edit/delete buttons
        document.getElementById('portfolio-property-edit-btn')?.addEventListener('click', () => {
            PortfolioApp.showEditPropertyModal(property.id);
        });
        document.getElementById('portfolio-property-delete-btn')?.addEventListener('click', () => {
            PortfolioApp.deleteProperty(property.id);
        });
    },

    // ---- Detail Charts (ticker price/value, account value) ----

    renderDetailChart(containerId, history, valueKey, hideValues) {
        const container = document.getElementById(containerId);
        if (!container) return;

        if (!history || history.length < 2) {
            container.innerHTML = '';
            container.style.display = 'none';
            return;
        }

        container.style.display = '';
        const width = container.clientWidth || 600;
        const height = 160;
        const padding = { top: 16, right: 16, bottom: 28, left: hideValues ? 16 : 64 };

        const values = history.map(s => s[valueKey]);
        const minVal = Math.min(...values);
        const maxVal = Math.max(...values);
        const range = maxVal - minVal || 1;

        const chartW = width - padding.left - padding.right;
        const chartH = height - padding.top - padding.bottom;

        const toX = (i) => padding.left + (i / (history.length - 1)) * chartW;
        const toY = (v) => padding.top + chartH - ((v - minVal) / range) * chartH;

        const first = values[0];
        const last = values[values.length - 1];
        const isUp = last >= first;
        const lineColor = isUp ? '#16a34a' : '#dc2626';
        const fillColor = isUp ? 'rgba(22, 163, 74, 0.08)' : 'rgba(220, 38, 38, 0.08)';

        let pathD = `M ${toX(0)} ${toY(values[0])}`;
        for (let i = 1; i < values.length; i++) {
            pathD += ` L ${toX(i)} ${toY(values[i])}`;
        }
        let areaD = pathD + ` L ${toX(values.length - 1)} ${padding.top + chartH} L ${toX(0)} ${padding.top + chartH} Z`;

        // Y-axis
        let yLabelsHtml = '';
        if (!hideValues) {
            const yTicks = 4;
            for (let i = 0; i <= yTicks; i++) {
                const val = minVal + (range * i / yTicks);
                const y = toY(val);
                const label = val >= 1000000 ? `$${(val / 1000000).toFixed(1)}M` :
                              val >= 1000 ? `$${(val / 1000).toFixed(0)}K` :
                              `$${val.toFixed(0)}`;
                yLabelsHtml += `<text x="${padding.left - 8}" y="${y + 4}" text-anchor="end" class="portfolio-chart-label">${label}</text>`;
                yLabelsHtml += `<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" class="portfolio-chart-grid"/>`;
            }
        }

        // X-axis
        let xLabelsHtml = '';
        const maxXLabels = Math.min(6, history.length);
        const step = Math.max(1, Math.floor((history.length - 1) / (maxXLabels - 1)));
        for (let i = 0; i < history.length; i += step) {
            const x = toX(i);
            const d = new Date(history[i].date + 'T00:00:00');
            const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            xLabelsHtml += `<text x="${x}" y="${height - 4}" text-anchor="middle" class="portfolio-chart-label">${label}</text>`;
        }
        if ((history.length - 1) % step !== 0) {
            const x = toX(history.length - 1);
            const d = new Date(history[history.length - 1].date + 'T00:00:00');
            const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            xLabelsHtml += `<text x="${x}" y="${height - 4}" text-anchor="middle" class="portfolio-chart-label">${label}</text>`;
        }

        // Hover dots
        let dotsHtml = '';
        for (let i = 0; i < values.length; i++) {
            dotsHtml += `<circle cx="${toX(i)}" cy="${toY(values[i])}" r="12" fill="transparent" class="portfolio-chart-hover-dot" data-idx="${i}"/>`;
            dotsHtml += `<circle cx="${toX(i)}" cy="${toY(values[i])}" r="3" fill="${lineColor}" opacity="0" class="portfolio-chart-dot" data-idx="${i}"/>`;
        }

        container.innerHTML = `
            <svg width="${width}" height="${height}" class="portfolio-chart-svg">
                ${yLabelsHtml}
                ${xLabelsHtml}
                <path d="${areaD}" fill="${fillColor}"/>
                <path d="${pathD}" fill="none" stroke="${lineColor}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
                ${dotsHtml}
            </svg>
            <div class="portfolio-chart-tooltip" style="display:none;"></div>
        `;

        // Hover interaction
        const svg = container.querySelector('svg');
        const tooltip = container.querySelector('.portfolio-chart-tooltip');
        const allDots = container.querySelectorAll('.portfolio-chart-dot');

        svg.addEventListener('mousemove', (e) => {
            const rect = svg.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;

            let nearest = 0;
            let nearestDist = Infinity;
            for (let i = 0; i < values.length; i++) {
                const dist = Math.abs(toX(i) - mouseX);
                if (dist < nearestDist) {
                    nearestDist = dist;
                    nearest = i;
                }
            }

            allDots.forEach(d => d.setAttribute('opacity', '0'));
            const activeDot = container.querySelector(`.portfolio-chart-dot[data-idx="${nearest}"]`);
            if (activeDot) activeDot.setAttribute('opacity', '1');

            const entry = history[nearest];
            const d = new Date(entry.date + 'T00:00:00');
            const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            const valStr = hideValues ? '••••' : this.formatMoney(entry[valueKey]);
            const changeFromFirst = entry[valueKey] - first;
            const changePct = first > 0 ? (changeFromFirst / first) * 100 : 0;
            const changeStr = hideValues ? '' : ` <span class="${this.plClass(changeFromFirst)}">${this.formatPL(changeFromFirst)} (${this.formatPercent(changePct)})</span>`;

            tooltip.innerHTML = `<strong>${dateStr}</strong><br>${valStr}${changeStr}`;
            tooltip.style.display = '';

            const tx = toX(nearest);
            const tooltipW = tooltip.offsetWidth;
            let left = tx - tooltipW / 2;
            if (left < 0) left = 0;
            if (left + tooltipW > width) left = width - tooltipW;
            tooltip.style.left = left + 'px';
            tooltip.style.top = '0px';
        });

        svg.addEventListener('mouseleave', () => {
            allDots.forEach(d => d.setAttribute('opacity', '0'));
            tooltip.style.display = 'none';
        });
    },

    // ---- Value History Chart ----

    /** Slice value history down to the selected window ('1m'|'3m'|'1y'|'all'). */
    filterHistoryByRange(history, chartRange) {
        const days = { '1m': 30, '3m': 91, '1y': 365 }[chartRange];
        if (!days) return history;
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - days);
        return history.filter(s => new Date(s.date + 'T00:00:00') >= cutoff);
    },

    renderValueChart(fullHistory, hideValues) {
        const container = document.getElementById('portfolio-value-chart');
        if (!container) return;

        if (!fullHistory || fullHistory.length < 2) {
            container.innerHTML = '';
            container.style.display = 'none';
            return;
        }

        container.style.display = '';

        const chartRange = PortfolioApp.chartRange || 'all';
        const history = this.filterHistoryByRange(fullHistory, chartRange);

        const rangesHtml = `
            <div class="portfolio-chart-ranges" role="tablist" aria-label="Chart time range">
                ${[['1m', '1M'], ['3m', '3M'], ['1y', '1Y'], ['all', 'All']].map(([id, label]) =>
                    `<button type="button" role="tab" class="portfolio-chart-range-btn ${id === chartRange ? 'is-active' : ''}"
                        data-range="${id}" aria-selected="${id === chartRange}">${label}</button>`).join('')}
            </div>`;
        const bindRanges = () => {
            container.querySelectorAll('.portfolio-chart-range-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    PortfolioApp.chartRange = btn.dataset.range;
                    // Machine-local — a display preference, not portfolio data.
                    try { localStorage.setItem('portfolio-chart-range', btn.dataset.range); } catch (e) { /* ignore */ }
                    this.renderValueChart(fullHistory, hideValues);
                });
            });
        };

        // A window narrower than the history can leave <2 points — keep the
        // pills so the user can widen the range again.
        if (history.length < 2) {
            container.innerHTML = rangesHtml +
                '<p class="portfolio-chart-sparse">Not enough history in this range yet.</p>';
            bindRanges();
            return;
        }
        const width = container.clientWidth || 600;
        const height = 180;
        const padding = { top: 20, right: 16, bottom: 28, left: hideValues ? 16 : 64 };

        const values = history.map(s => s.totalValue);
        const minVal = Math.min(...values);
        const maxVal = Math.max(...values);
        const range = maxVal - minVal || 1;

        const chartW = width - padding.left - padding.right;
        const chartH = height - padding.top - padding.bottom;

        const toX = (i) => padding.left + (i / (history.length - 1)) * chartW;
        const toY = (v) => padding.top + chartH - ((v - minVal) / range) * chartH;

        // Determine color based on overall direction
        const first = values[0];
        const last = values[values.length - 1];
        const isUp = last >= first;
        const lineColor = isUp ? '#16a34a' : '#dc2626';
        const fillColor = isUp ? 'rgba(22, 163, 74, 0.08)' : 'rgba(220, 38, 38, 0.08)';

        // Check dark mode
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        if (isDark) {
            // Adjust fill for dark mode
        }

        // Build SVG path
        let pathD = `M ${toX(0)} ${toY(values[0])}`;
        for (let i = 1; i < values.length; i++) {
            pathD += ` L ${toX(i)} ${toY(values[i])}`;
        }

        // Fill area path
        let areaD = pathD + ` L ${toX(values.length - 1)} ${padding.top + chartH} L ${toX(0)} ${padding.top + chartH} Z`;

        // Y-axis labels
        const yTicks = 4;
        let yLabelsHtml = '';
        if (!hideValues) {
            for (let i = 0; i <= yTicks; i++) {
                const val = minVal + (range * i / yTicks);
                const y = toY(val);
                const label = val >= 1000000 ? `$${(val / 1000000).toFixed(1)}M` :
                              val >= 1000 ? `$${(val / 1000).toFixed(0)}K` :
                              `$${val.toFixed(0)}`;
                yLabelsHtml += `<text x="${padding.left - 8}" y="${y + 4}" text-anchor="end" class="portfolio-chart-label">${label}</text>`;
                yLabelsHtml += `<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" class="portfolio-chart-grid"/>`;
            }
        }

        // X-axis labels (show a subset of dates)
        let xLabelsHtml = '';
        const maxXLabels = Math.min(6, history.length);
        const step = Math.max(1, Math.floor((history.length - 1) / (maxXLabels - 1)));
        for (let i = 0; i < history.length; i += step) {
            const x = toX(i);
            const d = new Date(history[i].date + 'T00:00:00');
            const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            xLabelsHtml += `<text x="${x}" y="${height - 4}" text-anchor="middle" class="portfolio-chart-label">${label}</text>`;
        }
        // Always show last date
        if ((history.length - 1) % step !== 0) {
            const x = toX(history.length - 1);
            const d = new Date(history[history.length - 1].date + 'T00:00:00');
            const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            xLabelsHtml += `<text x="${x}" y="${height - 4}" text-anchor="middle" class="portfolio-chart-label">${label}</text>`;
        }

        // Tooltip dots (invisible, activated by hover)
        let dotsHtml = '';
        for (let i = 0; i < values.length; i++) {
            dotsHtml += `<circle cx="${toX(i)}" cy="${toY(values[i])}" r="12" fill="transparent" class="portfolio-chart-hover-dot" data-idx="${i}"/>`;
            dotsHtml += `<circle cx="${toX(i)}" cy="${toY(values[i])}" r="3" fill="${lineColor}" opacity="0" class="portfolio-chart-dot" data-idx="${i}"/>`;
        }

        container.innerHTML = `
            ${rangesHtml}
            <svg width="${width}" height="${height}" class="portfolio-chart-svg">
                ${yLabelsHtml}
                ${xLabelsHtml}
                <path d="${areaD}" fill="${fillColor}"/>
                <path d="${pathD}" fill="none" stroke="${lineColor}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
                ${dotsHtml}
            </svg>
            <div id="portfolio-chart-tooltip" class="portfolio-chart-tooltip" style="display:none;"></div>
        `;
        bindRanges();

        // Hover interaction
        const svg = container.querySelector('svg');
        const tooltip = container.querySelector('#portfolio-chart-tooltip');
        const allDots = container.querySelectorAll('.portfolio-chart-dot');

        svg.addEventListener('mousemove', (e) => {
            const rect = svg.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;

            // Find nearest data point
            let nearest = 0;
            let nearestDist = Infinity;
            for (let i = 0; i < values.length; i++) {
                const dist = Math.abs(toX(i) - mouseX);
                if (dist < nearestDist) {
                    nearestDist = dist;
                    nearest = i;
                }
            }

            allDots.forEach(d => d.setAttribute('opacity', '0'));
            const activeDot = container.querySelector(`.portfolio-chart-dot[data-idx="${nearest}"]`);
            if (activeDot) activeDot.setAttribute('opacity', '1');

            const entry = history[nearest];
            const d = new Date(entry.date + 'T00:00:00');
            const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            const valStr = hideValues ? '••••' : this.formatMoney(entry.totalValue);
            const changeFromFirst = entry.totalValue - first;
            const changePct = first > 0 ? (changeFromFirst / first) * 100 : 0;
            const changeStr = hideValues ? '' : ` <span class="${this.plClass(changeFromFirst)}">${this.formatPL(changeFromFirst)} (${this.formatPercent(changePct)})</span>`;

            tooltip.innerHTML = `<strong>${dateStr}</strong><br>${valStr}${changeStr}`;
            tooltip.style.display = '';

            // Position tooltip
            const tx = toX(nearest);
            const tooltipW = tooltip.offsetWidth;
            let left = tx - tooltipW / 2;
            if (left < 0) left = 0;
            if (left + tooltipW > width) left = width - tooltipW;
            tooltip.style.left = left + 'px';
            tooltip.style.top = '0px';
        });

        svg.addEventListener('mouseleave', () => {
            allDots.forEach(d => d.setAttribute('opacity', '0'));
            tooltip.style.display = 'none';
        });
    },

    // ---- Snapshots View ----

    renderSnapshotsChart(history, hideValues) {
        const container = document.getElementById('portfolio-snapshots-chart');
        if (!container) return;

        if (!history || history.length < 2) {
            container.innerHTML = '<p style="padding: 1rem; opacity: 0.5;">Need at least 2 snapshots to show chart.</p>';
            return;
        }

        container.style.display = '';
        const width = container.clientWidth || 600;
        const height = 220;
        const padding = { top: 20, right: 16, bottom: 28, left: hideValues ? 16 : 64 };

        const values = history.map(s => s.totalValue);
        const minVal = Math.min(...values);
        const maxVal = Math.max(...values);
        const range = maxVal - minVal || 1;

        const chartW = width - padding.left - padding.right;
        const chartH = height - padding.top - padding.bottom;

        const toX = (i) => padding.left + (i / (history.length - 1)) * chartW;
        const toY = (v) => padding.top + chartH - ((v - minVal) / range) * chartH;

        const first = values[0];
        const last = values[values.length - 1];
        const isUp = last >= first;
        const lineColor = isUp ? '#16a34a' : '#dc2626';
        const fillColor = isUp ? 'rgba(22, 163, 74, 0.08)' : 'rgba(220, 38, 38, 0.08)';

        let pathD = `M ${toX(0)} ${toY(values[0])}`;
        for (let i = 1; i < values.length; i++) {
            pathD += ` L ${toX(i)} ${toY(values[i])}`;
        }
        let areaD = pathD + ` L ${toX(values.length - 1)} ${padding.top + chartH} L ${toX(0)} ${padding.top + chartH} Z`;

        let yLabelsHtml = '';
        if (!hideValues) {
            const yTicks = 4;
            for (let i = 0; i <= yTicks; i++) {
                const val = minVal + (range * i / yTicks);
                const y = toY(val);
                const label = val >= 1000000 ? `$${(val / 1000000).toFixed(1)}M` :
                              val >= 1000 ? `$${(val / 1000).toFixed(0)}K` :
                              `$${val.toFixed(0)}`;
                yLabelsHtml += `<text x="${padding.left - 8}" y="${y + 4}" text-anchor="end" class="portfolio-chart-label">${label}</text>`;
                yLabelsHtml += `<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" class="portfolio-chart-grid"/>`;
            }
        }

        let xLabelsHtml = '';
        const maxXLabels = Math.min(8, history.length);
        const step = Math.max(1, Math.floor((history.length - 1) / (maxXLabels - 1)));
        for (let i = 0; i < history.length; i += step) {
            const x = toX(i);
            const d = new Date(history[i].date + 'T00:00:00');
            const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            xLabelsHtml += `<text x="${x}" y="${height - 4}" text-anchor="middle" class="portfolio-chart-label">${label}</text>`;
        }
        if ((history.length - 1) % step !== 0) {
            const x = toX(history.length - 1);
            const d = new Date(history[history.length - 1].date + 'T00:00:00');
            const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            xLabelsHtml += `<text x="${x}" y="${height - 4}" text-anchor="middle" class="portfolio-chart-label">${label}</text>`;
        }

        let dotsHtml = '';
        for (let i = 0; i < values.length; i++) {
            dotsHtml += `<circle cx="${toX(i)}" cy="${toY(values[i])}" r="4" fill="${lineColor}" class="portfolio-chart-dot" data-idx="${i}"/>`;
        }

        container.innerHTML = `
            <svg width="${width}" height="${height}" class="portfolio-chart-svg">
                ${yLabelsHtml}
                ${xLabelsHtml}
                <path d="${areaD}" fill="${fillColor}"/>
                <path d="${pathD}" fill="none" stroke="${lineColor}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
                ${dotsHtml}
            </svg>
        `;
    },

    renderSnapshotsTable(history, hideValues) {
        const container = document.getElementById('portfolio-snapshots-table');
        if (!container) return;

        if (!history || history.length === 0) {
            container.innerHTML = '<p style="padding: 1rem; opacity: 0.5;">No snapshots yet. Click "Take Snapshot" to record one.</p>';
            return;
        }

        const sorted = [...history].sort((a, b) => b.date.localeCompare(a.date));

        let rows = '';
        sorted.forEach((snap, idx) => {
            const d = new Date(snap.date + 'T00:00:00');
            const dateStr = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
            const totalVal = hideValues ? '****' : this.formatMoney(snap.totalValue);
            const stockVal = hideValues ? '****' : this.formatMoney(snap.stockValue || 0);
            const cashVal = hideValues ? '****' : this.formatMoney(snap.cash || 0);
            const reVal = hideValues ? '****' : this.formatMoney(snap.realEstateValue || 0);

            // Day-over-day change. The percent survives masking — a
            // relative move doesn't leak balances the way dollars do.
            const prevIdx = history.indexOf(snap) - 1;
            let changeHtml = '—';
            if (prevIdx >= 0) {
                const prev = history[prevIdx];
                const change = snap.totalValue - prev.totalValue;
                const changePct = prev.totalValue > 0 ? (change / prev.totalValue) * 100 : 0;
                changeHtml = hideValues
                    ? `<span class="${this.plClass(change)}">${this.formatPercent(changePct)}</span>`
                    : `<span class="${this.plClass(change)}">${this.formatPL(change)} (${this.formatPercent(changePct)})</span>`;
            }

            rows += `
                <tr>
                    <td>${dateStr}</td>
                    <td class="num">${totalVal}</td>
                    <td class="num">${stockVal}</td>
                    <td class="num">${cashVal}</td>
                    <td class="num">${reVal}</td>
                    <td class="num">${changeHtml}</td>
                    <td><button class="snapshot-delete-btn secondary-btn" data-date="${snap.date}">Delete</button></td>
                </tr>
            `;
        });

        container.innerHTML = `
            <table class="portfolio-table">
                <thead>
                    <tr>
                        <th>Date</th>
                        <th class="num">Total Value</th>
                        <th class="num">Stocks</th>
                        <th class="num">Cash</th>
                        <th class="num">Real Estate</th>
                        <th class="num">Change</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        `;

        container.querySelectorAll('.snapshot-delete-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                PortfolioApp.deleteSnapshot(btn.dataset.date);
            });
        });
    },

    // ---- Dashboard Preview ----

    renderDashboardPreview() {
        const container = document.getElementById('portfolio-preview');
        if (!container) return;

        const holdings = PortfolioApp.computeHoldings();
        const totalCash = PortfolioApp.computeTotalCash();
        const properties = PortfolioApp.properties || [];

        if (holdings.length === 0 && totalCash === 0 && properties.length === 0) {
            container.innerHTML = '<p class="preview-empty">No holdings yet</p>';
            return;
        }

        const summary = PortfolioApp.getSummary(holdings);
        const top3 = holdings.slice(0, 3);

        container.innerHTML = `
            <div class="portfolio-preview-summary">
                <span class="portfolio-preview-value">${this.hv(this.formatMoney(summary.totalValue))}</span>
                <span class="portfolio-preview-pl ${this.hvPlClass(summary.totalPL)}">${this.hv(this.formatPL(summary.totalPL))} (${this.formatPercent(summary.totalPLPercent)})</span>
            </div>
            <ul class="preview-list">
                ${top3.map(h => `
                    <li class="preview-item">
                        <span class="portfolio-preview-ticker">${h.ticker}</span>
                        <span class="portfolio-preview-item-value">${this.hv(this.formatMoney(h.currentValue))}</span>
                    </li>
                `).join('')}
            </ul>
            ${holdings.length > 3 ? `<p class="preview-more">+${holdings.length - 3} more</p>` : ''}
        `;
    },

    // ---- Utility: Refreshing indicator ----

    setRefreshing(isRefreshing) {
        const btn = document.getElementById('portfolio-refresh-btn');
        if (btn) {
            btn.disabled = isRefreshing;
            btn.textContent = isRefreshing ? 'Refreshing...' : 'Refresh Prices';
        }
    },

    // ---- Hide Values Toggle ----

    updateHideValuesBtn(hidden) {
        const btn = document.getElementById('portfolio-toggle-values');
        if (!btn) return;
        // Eye (visible) vs eye-off (masked) — CSS swaps on .is-masked.
        btn.classList.toggle('is-masked', hidden);
        const label = hidden ? 'Show values' : 'Hide values';
        btn.title = label;
        btn.setAttribute('aria-label', label);
    },

    // ---- Formatting helpers ----

    formatMoney(value) {
        if (value === 0 || value === undefined || value === null) return '$0.00';
        const abs = '$' + Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        // A negative balance (e.g. cash overdrawn by a buy) must read as
        // negative — Math.abs alone silently flipped the sign.
        return value < 0 ? '-' + abs : abs;
    },

    formatPL(value) {
        if (!value) return '$0.00';
        const sign = value >= 0 ? '+' : '-';
        return sign + '$' + Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    },

    formatPercent(value) {
        if (!value) return '0.00%';
        const sign = value >= 0 ? '+' : '';
        return sign + value.toFixed(2) + '%';
    },

    /** Format a sensitive value (hidden when hideValues is on) */
    hv(formatted) {
        return PortfolioApp.hideValues ? '••••' : formatted;
    },

    formatShares(value) {
        if (Number.isInteger(value)) return value.toString();
        return value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
    },

    formatDate(dateStr) {
        const d = new Date(dateStr + 'T00:00:00');
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    },

    formatAccountType(type) {
        const map = {
            'brokerage': 'Brokerage',
            '401k': '401(k)',
            'ira': 'IRA',
            'roth-ira': 'Roth IRA',
            'hsa': 'HSA',
            'savings': 'Savings',
            'checking': 'Checking',
            'other': 'Other'
        };
        return map[type] || type;
    },

    plClass(value) {
        if (!value || value === 0) return '';
        return value > 0 ? 'pl-positive' : 'pl-negative';
    },

    /** P&L class that hides color when values are hidden */
    hvPlClass(value) {
        return PortfolioApp.hideValues ? '' : this.plClass(value);
    }
};
