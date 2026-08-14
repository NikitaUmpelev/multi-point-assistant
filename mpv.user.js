// ==UserScript==
// @name         Ассистент Multi-Point DEMO
// @namespace    http://tampermonkey.net/
// @version      1.36
// @description  Управление заказами, ячейками, историей, менеджером модулей; единая панель выдачи (выдача + автоподсчёт/отказы + бесплатный озон + Яндекс Маркет выкуп + касса с инкассацией); синхронизация с npoint
// @match        https://operator.multi-point.org/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @connect      api.npoint.io
// @updateURL    https://github.com/NikitaUmpelev/multi-point-assistant/raw/refs/heads/main/mpv.user.js
// @downloadURL  https://github.com/NikitaUmpelev/multi-point-assistant/raw/refs/heads/main/mpv.user.js
// ==/UserScript==

(function() {
    'use strict';

    // ==========================================
    // НАСТРОЙКИ NPOINT (Вставьте сюда ваши URL)
    // ==========================================
    const NPOINT_CONFIG = {
        CELLS_URL: 'https://api.npoint.io/93b7232626e8448c888c', // 1. История ячеек с содержимым
        CASH_URL: 'https://api.npoint.io/0fde509bc06c15258328', // 2. Касса
        ITEMS_URL: 'https://api.npoint.io/03e0f5ac944570d1491b' // 3. Информация об элементах в ячейках
    };

    // ==========================================
    // ОЧЕРЕДЬ И СИНХРОНИЗАЦИЯ NPOINT
    // ==========================================
    let npointQueue = Promise.resolve();

    function sendToNpoint(url, payload) {
        if (!url || url.includes('YOUR_')) return Promise.resolve();

        npointQueue = npointQueue.then(() => {
            return new Promise((resolve) => {
                GM_xmlhttpRequest({
                    method: 'POST',
                    url: url,
                    headers: { 'Content-Type': 'application/json' },
                    data: JSON.stringify(payload),
                    onload: (response) => {
                        if (response.status >= 200 && response.status < 300) {
                            console.log('✅ [npoint Sync OK]:', url);
                        } else {
                            console.error('❌ [npoint Sync Error]:', response.statusText, url);
                        }
                        resolve();
                    },
                    onerror: (err) => {
                        console.error('❌ [npoint Network Error]:', err, url);
                        resolve(); // Разрешаем Promise, чтобы очередь не застревала
                    }
                });
            });
        }).catch(err => console.error('[Queue Exception]', err));

        return npointQueue;
    }

    // Вспомогательные функции синхронизации по типам
    function syncNpointCells() {
        const payload = {
            occupied_cells: GM_getValue('mp_occupied_cells', {}),
            grid_state: GM_getValue('mp_grid_state', {}),
            updated_at: new Date().toISOString()
        };
        return sendToNpoint(NPOINT_CONFIG.CELLS_URL, payload);
    }

    function syncNpointCash() {
        const payload = {
            transactions: GM_getValue('mp_cash_transactions', []),
            state: GM_getValue('mp_cash_state', { encashmentSerial: 1, lastEncashmentAt: null }),
            adjustments: GM_getValue('mp_cash_adjustments', []),
            encashments: GM_getValue('mp_cash_encashments', []),
            updated_at: new Date().toISOString()
        };
        return sendToNpoint(NPOINT_CONFIG.CASH_URL, payload);
    }

    function syncNpointItems() {
        const payload = {
            item_history: GM_getValue('mp_item_history', {}),
            updated_at: new Date().toISOString()
        };
        return sendToNpoint(NPOINT_CONFIG.ITEMS_URL, payload);
    }

    function showNotification(text) {
        const notif = document.createElement('div');
        notif.innerText = text;
        notif.style.cssText = 'position:fixed; bottom:20px; right:20px; background:#333; color:#fff; padding:10px 20px; border-radius:5px; z-index:99999;';
        document.body.appendChild(notif);
        setTimeout(() => notif.remove(), 3000);
    }

    // Хранилище настроек включения/выключения модулей
    let moduleSettings = GM_getValue('mp_module_settings', {
        acceptance: true,
        issuance: true,
        autocalc: true,
        freeOzon: true,
        cash: true,
        history: true
    });

    function saveModuleSettings() {
        GM_setValue('mp_module_settings', moduleSettings);
    }

    // ==========================================
    // ОБЩИЕ ХЕЛПЕРЫ: КАССА И АДМИН-ФУНКЦИИ
    // ==========================================
    const ADMIN_PASSWORD_ENCODED = 'MTAyOTM4NDc1Ng==';
    function getAdminPassword() {
        try {
            return atob(ADMIN_PASSWORD_ENCODED);
        } catch (e) {
            return '';
        }
    }
    let adminUnlocked = false;

    function requireAdmin(onSuccess) {
        if (adminUnlocked) { onSuccess(); return; }
        const pass = prompt('Введите пароль администратора:');
        if (pass === getAdminPassword()) {
            adminUnlocked = true;
            onSuccess();
        } else if (pass !== null) {
            alert('Неверный пароль!');
        }
    }

    function getTodayRange() {
        const now = new Date();
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        return { start, end: Date.now() };
    }

    function getMondayOfWeek(timestamp) {
        const d = new Date(timestamp);
        const day = d.getDay();
        const diff = (day === 0 ? -6 : 1) - day;
        d.setDate(d.getDate() + diff);
        d.setHours(0, 0, 0, 0);
        return d.getTime();
    }

    function recordCashTransaction(amount, method, orderNum) {
        if (!amount || amount <= 0) return;
        const transactions = GM_getValue('mp_cash_transactions', []);
        transactions.push({
            id: Date.now() + '_' + Math.random().toString(36).slice(2, 8),
            timestamp: Date.now(),
            amount: amount,
            method: method || 'cash',
            orderNum: orderNum || ''
        });
        GM_setValue('mp_cash_transactions', transactions);
        syncNpointCash();
    }

    function getCashState() {
        return GM_getValue('mp_cash_state', { encashmentSerial: 1, lastEncashmentAt: null });
    }

    function saveCashState(state) {
        GM_setValue('mp_cash_state', state);
        syncNpointCash();
    }

    function sumTransactionsInRange(start, end) {
        const transactions = GM_getValue('mp_cash_transactions', []);
        const adjustments = GM_getValue('mp_cash_adjustments', []);
        const result = { cash: 0, card: 0, qr: 0, adjust: 0, total: 0 };
        transactions.forEach(t => {
            if (t.timestamp >= start && t.timestamp <= end) {
                const method = result.hasOwnProperty(t.method) ? t.method : 'cash';
                result[method] += t.amount;
                result.total += t.amount;
            }
        });
        adjustments.forEach(a => {
            if (a.timestamp >= start && a.timestamp <= end) {
                result.adjust += a.amount;
                result.total += a.amount;
            }
        });
        return result;
    }

    function releaseCellManually(cellName) {
        const occupiedCells = GM_getValue('mp_occupied_cells', {});
        if (occupiedCells[cellName]) {
            delete occupiedCells[cellName];
            GM_setValue('mp_occupied_cells', occupiedCells);
            syncNpointCells();
            showNotification(`🔓 Ячейка ${cellName} освобождена вручную`);
        }
    }

    function manualIssueFromHistory(barcode) {
        const itemHistory = GM_getValue('mp_item_history', {});
        const item = itemHistory[barcode];
        if (!item) return;
        if (item.status === 'выдан' || item.status === 'выдача') {
            alert('Этот элемент уже выдан!');
            return;
        }
        item.status = 'выдан';
        item.issuedAt = new Date().toLocaleString();
        itemHistory[barcode] = item;
        GM_setValue('mp_item_history', itemHistory);
        syncNpointItems();

        let occupiedCells = GM_getValue('mp_occupied_cells', {});
        let cellsToRelease = [];
        if (item.cell && item.cell.endsWith('+г')) {
            cellsToRelease.push(item.cell, item.cell.replace('+г', ''));
        } else if (item.cell) {
            cellsToRelease.push(item.cell);
        }
        cellsToRelease.forEach(cName => {
            if (occupiedCells[cName]) {
                occupiedCells[cName].count = Math.max(0, occupiedCells[cName].count - 1);
                if (occupiedCells[cName].items) {
                    occupiedCells[cName].items = occupiedCells[cName].items.filter(i => i.barcode !== barcode);
                }
                if (occupiedCells[cName].count === 0) delete occupiedCells[cName];
            }
        });
        GM_setValue('mp_occupied_cells', occupiedCells);
        syncNpointCells();
        showNotification(`✅ Заказ ${barcode} выдан вручную, ячейка освобождена`);
    }
    window.mpManualIssue = manualIssueFromHistory;

    function addManualCashAdjustment(amount, note) {
        if (!amount) return;
        const adjustments = GM_getValue('mp_cash_adjustments', []);
        adjustments.push({
            id: Date.now() + '_' + Math.random().toString(36).slice(2, 8),
            timestamp: Date.now(),
            amount: amount,
            note: note || ''
        });
        GM_setValue('mp_cash_adjustments', adjustments);
        syncNpointCash();
        showNotification(`✏️ Корректировка кассы: ${amount > 0 ? '+' : ''}${amount}р`);
    }

    // ==========================================
    // 1. МОДУЛЬ: ПРИЁМ ЗАКАЗОВ
    // ==========================================
    function initAcceptanceModule() {
        const currentUrl = window.location.href;
        const isParcelRoute = currentUrl.includes('route=parcel/');
        const isStorageRoute1 = /operator\.multi-point\.org\/index\.php\?route=parcel\/module\/shipment\/default&company_id=/.test(currentUrl);
        const isStorageRoute2 = /operator\.multi-point\.org\/index\.php\?route=parcel\/shipment\/update&company_id=/.test(currentUrl);

        if (!moduleSettings.acceptance || (!isParcelRoute && !isStorageRoute1 && !isStorageRoute2)) return;

        showNotification('🚀 Запущен модуль: ПРИЁМ ЗАКАЗОВ');

        let gridState = GM_getValue('mp_grid_state', { normal: 10, g: 10, plusG: 10, kg: 10 });
        let occupiedCells = GM_getValue('mp_occupied_cells', {});
        let itemHistory = GM_getValue('mp_item_history', {});
        let panelState = GM_getValue('mp_panel_state', null);

        const NATIVE_STORAGE_SELECTOR = '#storage';
        const NATIVE_ACCEPT_BTN_TEXT = 'Скачать АПП и Принять';

        const style = document.createElement('style');
        style.innerHTML = `
            #mp-custom-storage {
                position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
                background: #ffffff; padding: 25px; border-radius: 8px; z-index: 30000;
                box-shadow: 0 10px 30px rgba(0,0,0,0.5); display: none;
                width: 680px; font-family: sans-serif; max-height: 90vh; overflow-y: auto;
            }
            .mp-grid-section { margin-bottom: 20px; padding: 12px; border-radius: 6px; border: 1px solid rgba(0,0,0,0.08); }
            .mp-section-normal { background: #f8f9fa; border-left: 5px solid #6c757d; }
            .mp-section-g { background: #fff3cd; border-left: 5px solid #ffc107; }
            .mp-section-plusG { background: #d1e7dd; border-left: 5px solid #198754; }
            .mp-section-kg { background: #f8d7da; border-left: 5px solid #dc3545; }
            .mp-grid-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; font-weight: bold; font-size: 15px; color: #333; border-bottom: 1px solid rgba(0,0,0,0.1); padding-bottom: 5px; }
            .mp-controls button { background: #ffffff; border: 1px solid #ccc; border-radius: 4px; width: 30px; height: 30px; font-size: 18px; cursor: pointer; margin-left: 5px; font-weight: bold; }
            .mp-controls button:hover { background: #e9ecef; }
            .mp-grid-container { display: grid; grid-template-columns: repeat(auto-fill, minmax(65px, 1fr)); gap: 8px; max-height: 140px; overflow-y: auto; padding-right: 5px; }
            .mp-cell { background: #ffffff; border: 1px solid rgba(0,0,0,0.15); text-align: center; padding: 10px 5px; cursor: pointer; border-radius: 4px; font-weight: bold; font-size: 14px; transition: all 0.1s; color: #333; box-shadow: 0 1px 2px rgba(0,0,0,0.05); position: relative; }
            .mp-cell:hover { background: #343a40; color: #fff; transform: scale(1.05); }
            .mp-cell.occupied { background: #f8d7da !important; border-color: #dc3545 !important; color: #842029 !important; }
            .mp-cell-badge { position: absolute; top: -5px; right: -5px; background: #dc3545; color: #fff; font-size: 10px; padding: 2px 5px; border-radius: 50%; font-weight: bold; }
            #mp-side-panel { position: fixed; top: 120px; right: 20px; width: 340px; min-width: 240px; min-height: 110px; max-width: 80vw; max-height: 80vh; background: #2c3e50; color: #ecf0f1; border-radius: 8px; z-index: 19999; display: none; box-shadow: 0 4px 15px rgba(0,0,0,0.35); border-left: 5px solid #27ae60; overflow: auto; resize: both; font-size: 13px; }
            #mp-panel-header { cursor: move; user-select: none; background: rgba(255,255,255,0.08); padding: 8px 12px; font-weight: bold; border-radius: 3px 3px 0 0; }
            #mp-panel-body { padding: 12px; }
            .mp-panel-section { margin-bottom: 12px; }
            .mp-panel-section:last-child { margin-bottom: 0; }
            #mp-active-cell-value { display: block; font-size: 18px; font-weight: bold; color: #2ecc71; margin-top: 4px; }
            .mp-widget-item-list { margin-top: 8px; border-top: 1px solid rgba(255,255,255,0.2); padding-top: 6px; }
            #mp-floating-accept-btn { width: 100%; background: #198754; color: #ffffff; padding: 12px 16px; border-radius: 6px; font-weight: bold; cursor: pointer; border: none; font-size: 14px; transition: background 0.2s; }
            #mp-floating-accept-btn:hover { background: #157347; }
            .mp-native-hidden { display: none !important; }
        `;
        document.head.appendChild(style);

        const sidePanel = document.createElement('div');
        sidePanel.id = 'mp-side-panel';
        sidePanel.innerHTML = `
            <div id="mp-panel-header">📦 Ячейка в работе</div>
            <div id="mp-panel-body">
                <div class="mp-panel-section">
                    <span id="mp-active-cell-value">-</span>
                    <div id="mp-active-cell-details" class="mp-widget-item-list"></div>
                </div>
                <div class="mp-panel-section">
                    <button id="mp-floating-accept-btn">📥 Скачать АПП и Принять</button>
                </div>
            </div>
        `;
        document.body.appendChild(sidePanel);
        const floatingBtn = sidePanel.querySelector('#mp-floating-accept-btn');

        if (panelState) {
            if (panelState.top) sidePanel.style.top = panelState.top;
            if (panelState.left) { sidePanel.style.left = panelState.left; sidePanel.style.right = 'auto'; }
            if (panelState.width) sidePanel.style.width = panelState.width;
            if (panelState.height) sidePanel.style.height = panelState.height;
        }

        function savePanelState() {
            GM_setValue('mp_panel_state', { top: sidePanel.style.top, left: sidePanel.style.left, width: sidePanel.style.width, height: sidePanel.style.height });
        }

        let resizeTimeout;
        new ResizeObserver(() => {
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(savePanelState, 500);
        }).observe(sidePanel);

        makePanelDraggable(sidePanel, sidePanel.querySelector('#mp-panel-header'));

        const customModal = document.createElement('div');
        customModal.id = 'mp-custom-storage';
        document.body.appendChild(customModal);

        const gridsConfig = [
            { id: 'normal', title: '1. Обычные', suffix: '', class: 'mp-section-normal' },
            { id: 'g', title: '2. Габаритные', suffix: 'г', class: 'mp-section-g' },
            { id: 'plusG', title: '3. Обычные + габаритные', suffix: '+г', class: 'mp-section-plusG' },
            { id: 'kg', title: '4. Крупногабаритные', suffix: 'кг', class: 'mp-section-kg' }
        ];

        function renderGrids() {
            const scrollPositions = {};
            const oldContainers = customModal.querySelectorAll('.mp-grid-container');
            oldContainers.forEach((cont, idx) => { scrollPositions[gridsConfig[idx].id] = cont.scrollTop; });

            customModal.innerHTML = '';
            const closeBtn = document.createElement('button');
            closeBtn.innerText = '✕ Закрыть';
            closeBtn.style.cssText = 'float:right; cursor:pointer; background:#dc3545; color:white; border:none; padding:6px 12px; border-radius:4px; margin-bottom:10px; font-weight:bold;';
            closeBtn.onclick = () => closeModal();
            customModal.appendChild(closeBtn);

            gridsConfig.forEach((grid) => {
                const section = document.createElement('div');
                section.className = `mp-grid-section ${grid.class}`;
                const header = document.createElement('div');
                header.className = 'mp-grid-header';
                const title = document.createElement('div');
                title.innerText = grid.title;
                const controls = document.createElement('div');
                controls.className = 'mp-controls';

                const btnMinus = document.createElement('button');
                btnMinus.innerText = '-';
                btnMinus.onclick = () => {
                    if (gridState[grid.id] > 1) {
                        gridState[grid.id]--;
                        GM_setValue('mp_grid_state', gridState);
                        syncNpointCells();
                        renderGrids();
                    }
                };

                const btnPlus = document.createElement('button');
                btnPlus.innerText = '+';
                btnPlus.onclick = () => {
                    gridState[grid.id]++;
                    GM_setValue('mp_grid_state', gridState);
                    syncNpointCells();
                    renderGrids();
                };

                controls.appendChild(btnMinus);
                controls.appendChild(btnPlus);
                header.appendChild(title);
                header.appendChild(controls);
                section.appendChild(header);

                const container = document.createElement('div');
                container.className = 'mp-grid-container';
                const count = gridState[grid.id];
                for (let i = 1; i <= count; i++) {
                    const cell = document.createElement('div');
                    cell.className = 'mp-cell';
                    const cellValue = `${i}${grid.suffix}`;
                    cell.innerText = cellValue;

                    if (occupiedCells[cellValue] && occupiedCells[cellValue].count > 0) {
                        cell.classList.add('occupied');
                        const badge = document.createElement('div');
                        badge.className = 'mp-cell-badge';
                        badge.innerText = occupiedCells[cellValue].count;
                        cell.appendChild(badge);
                    }

                    cell.onclick = () => selectCell(cellValue);
                    container.appendChild(cell);
                }
                section.appendChild(container);
                customModal.appendChild(section);

                if (scrollPositions[grid.id] !== undefined) container.scrollTop = scrollPositions[grid.id];
            });
        }

        function openModal() {
            renderGrids();
            customModal.style.display = 'block';
            lockPageScroll();
        }

        function closeModal() {
            customModal.style.display = 'none';
            unlockPageScroll();
            setTimeout(() => {
                const nativeEl = document.querySelector(NATIVE_STORAGE_SELECTOR);
                if (nativeEl) nativeEl.classList.remove('mp-native-hidden');
            }, 500);
        }

        initPersistentModalInterceptor();
        initPersistentAcceptButtonHider();

        function selectCell(value) {
            const input = document.querySelector('#storage input.dark[name="code"]');
            if (input) {
                input.value = value;
                const enterEvent = new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true });
                input.dispatchEvent(enterEvent);
            }
            closeModal();
            document.getElementById('mp-active-cell-value').innerText = value;
            sidePanel.style.display = 'block';
            GM_setValue('activeCellForNextOrder', value);
            updateWidgetContent();
        }

        function parseCleanInfo(divText) {
            let parts = divText.split(': ');
            if (parts.length >= 3 && parts[0] === parts[1]) {
                return parts[0] + ': ' + parts.slice(2).join(': ');
            }
            return divText;
        }

        function getSelectedItemsData() {
            const items = [];
            const checkboxes = document.querySelectorAll('.box ul.list li input[type="checkbox"]:checked');

            checkboxes.forEach((chk, index) => {
                const li = chk.closest('li');
                if (!li) return;

                const divs = li.querySelectorAll('div');
                let supplier = '', receiver = '', sender = '', phone = '', sum = '';

                divs.forEach(d => {
                    const text = parseCleanInfo(d.innerText.trim());
                    if (text.includes('Номер поставщика:')) supplier = text;
                    else if (text.includes('Получатель:')) receiver = text;
                    else if (text.includes('Отправитель:')) sender = text;
                    else if (text.includes('Телефон:')) phone = text;
                    else if (text.includes('Сумма к оплате:')) sum = text;
                });

                const barcode = chk.getAttribute('barcode') || chk.value || 'Нет номера';
                items.push({
                    index: index + 1,
                    barcode: barcode,
                    info: [supplier, receiver, sender, phone, sum].filter(Boolean).join('<br>')
                });
            });
            return items;
        }

        function updateWidgetContent() {
            const detailsContainer = document.getElementById('mp-active-cell-details');
            if (!detailsContainer) return;
            const items = getSelectedItemsData();
            if (items.length === 0) {
                detailsContainer.innerHTML = '<i>Нет выбранных элементов</i>';
                return;
            }
            let html = '';
            items.forEach(item => {
                html += `<div style="margin-bottom: 8px;"><b>${item.index} элемент ${item.barcode}</b><br><span style="font-size: 12px; color: #cbd5e1;">${item.info}</span></div>`;
            });
            detailsContainer.innerHTML = html;
        }

        document.addEventListener('change', (e) => {
            if (e.target.matches('.box ul.list li input[type="checkbox"]')) updateWidgetContent();
        });

        floatingBtn.onclick = () => {
            const activeCell = GM_getValue('activeCellForNextOrder', null);
            if (!activeCell) { alert('Сначала выберите ячейку!'); return; }

            const items = getSelectedItemsData();
            if (items.length === 0) { alert('Не выбрано ни одного элемента (нет галочек)!'); return; }

            let cellsToUpdate = [];
            if (activeCell.endsWith('+г')) {
                cellsToUpdate.push(activeCell, activeCell.replace('+г', ''));
            } else {
                cellsToUpdate.push(activeCell);
            }

            cellsToUpdate.forEach(cellName => {
                if (!occupiedCells[cellName]) occupiedCells[cellName] = { count: 0, items: [] };
                occupiedCells[cellName].count += items.length;
                occupiedCells[cellName].items.push(...items);
            });

            items.forEach(item => {
                itemHistory[item.barcode] = {
                    barcode: item.barcode,
                    cell: activeCell,
                    info: item.info,
                    status: 'принят на хранение',
                    acceptedAt: new Date().toLocaleString(),
                    issuedAt: null
                };
            });

            GM_setValue('mp_occupied_cells', occupiedCells);
            GM_setValue('mp_item_history', itemHistory);

            // ПОСЛЕДОВАТЕЛЬНОЕ СОХРАНЕНИЕ В NPOINT
            syncNpointCells();
            syncNpointItems();

            showNotification(`✅ Данные сохранены в ячейку ${activeCell} (позиций: ${items.length})`);

            const originalBtn = document.querySelector('button.flat-button[onclick*="privat"]');
            if (originalBtn) {
                originalBtn.click();
            } else {
                const allButtons = document.querySelectorAll('button.flat-button');
                for (let btn of allButtons) {
                    if (btn.innerText.includes('Скачать АПП и Принять')) { btn.click(); break; }
                }
            }
        };

        function makePanelDraggable(panel, handle) {
            let dragging = false;
            let startX = 0, startY = 0, startLeft = 0, startTop = 0;
            handle.addEventListener('mousedown', (e) => {
                dragging = true;
                const rect = panel.getBoundingClientRect();
                panel.style.left = rect.left + 'px';
                panel.style.top = rect.top + 'px';
                panel.style.right = 'auto';
                startX = e.clientX; startY = e.clientY;
                startLeft = rect.left; startTop = rect.top;
                e.preventDefault();
            });
            document.addEventListener('mousemove', (e) => {
                if (!dragging) return;
                panel.style.left = (startLeft + (e.clientX - startX)) + 'px';
                panel.style.top = (startTop + (e.clientY - startY)) + 'px';
            });
            document.addEventListener('mouseup', () => {
                if (dragging) { dragging = false; savePanelState(); }
            });
        }

        function isInsideOurUI(el) {
            return !!(el && el.closest && (el.closest('#mp-custom-storage') || el.closest('#mp-side-panel')));
        }
        function handleWheel(e) { if (!isInsideOurUI(e.target)) e.preventDefault(); }
        function handleTouchMove(e) { if (!isInsideOurUI(e.target)) e.preventDefault(); }
        const MP_SCROLL_KEYS = ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '];
        function handleKeyDown(e) { if (MP_SCROLL_KEYS.includes(e.key) && !isInsideOurUI(e.target)) e.preventDefault(); }

        function lockPageScroll() {
            document.body.style.overflow = 'hidden';
            document.addEventListener('wheel', handleWheel, { passive: false });
            document.addEventListener('touchmove', handleTouchMove, { passive: false });
            document.addEventListener('keydown', handleKeyDown, true);
        }
        function unlockPageScroll() {
            document.body.style.overflow = '';
            document.removeEventListener('wheel', handleWheel, { passive: false });
            document.removeEventListener('touchmove', handleTouchMove, { passive: false });
            document.removeEventListener('keydown', handleKeyDown, true);
        }

        function initPersistentModalInterceptor() {
            function isVisible(el) {
                if (!el) return false;
                const cs = window.getComputedStyle(el);
                return cs.display !== 'none' && cs.visibility !== 'hidden' && el.offsetParent !== null;
            }
            function tick() {
                const nativeEl = document.querySelector(NATIVE_STORAGE_SELECTOR);
                if (nativeEl && isVisible(nativeEl)) {
                    nativeEl.classList.add('mp-native-hidden');
                    if (customModal.style.display !== 'block') openModal();
                }
            }
            let scheduled = false;
            function scheduleTick() {
                if (scheduled) return;
                scheduled = true;
                requestAnimationFrame(() => { scheduled = false; tick(); });
            }
            const observer = new MutationObserver(scheduleTick);
            observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
            setInterval(tick, 400);
            tick();
        }

        function initPersistentAcceptButtonHider() {
            function hideButtons() {
                document.querySelectorAll('button.flat-button').forEach(btn => {
                    if (btn.innerText.includes(NATIVE_ACCEPT_BTN_TEXT)) {
                        btn.style.setProperty('display', 'none', 'important');
                    }
                });
            }
            let scheduled = false;
            function scheduleHide() {
                if (scheduled) return;
                scheduled = true;
                requestAnimationFrame(() => { scheduled = false; hideButtons(); });
            }
            const observer = new MutationObserver(scheduleHide);
            observer.observe(document.body, { childList: true, subtree: true });
            setInterval(hideButtons, 500);
            hideButtons();
        }
    }

    // ==========================================
    // 2-5. МОДУЛЬ: ЕДИНАЯ ПАНЕЛЬ ВЫДАЧИ ЗАКАЗА
    // ==========================================
    function initOrderPanelModule(isBalancePage) {
        const executeBtn = document.querySelector('#button-execute');
        if (!executeBtn) return;

        const showIssuance = isBalancePage && moduleSettings.issuance;
        const showTemplates = isBalancePage && moduleSettings.autocalc;
        const showOzon = isBalancePage && moduleSettings.freeOzon;
        const showCash = moduleSettings.cash;

        if (!showIssuance && !showTemplates && !showOzon && !showCash) return;

        showNotification('🎛️ Запущен модуль: ПАНЕЛЬ ВЫДАЧИ ЗАКАЗА');

        if (isBalancePage) {
            const hideNativeStyle = document.createElement('style');
            hideNativeStyle.id = 'mp-hide-native-controls';
            hideNativeStyle.innerHTML = `.box-controls { display: none !important; }`;
            document.head.appendChild(hideNativeStyle);
        }

        const style = document.createElement('style');
        style.innerHTML = `
            #mp-order-panel { position: fixed; max-height: 82vh; background: #2c3e50; color: #ecf0f1; border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,0.45); z-index: 19999; display: none; flex-direction: column; font-family: sans-serif; font-size: 13px; overflow: hidden; resize: both; min-width: 300px; min-height: 200px; }
            #mp-op-header { display: flex; justify-content: space-between; align-items: center; background: #1f2c38; padding: 12px 16px; font-weight: bold; font-size: 15px; border-bottom: 3px solid #3498db; user-select: none; flex-shrink: 0; cursor: grab; }
            #mp-op-header:active { cursor: grabbing; }
            #mp-op-body { padding: 14px 16px; overflow-y: auto; flex: 1; }
            .mp-op-section { margin-bottom: 14px; padding: 10px 12px; border-radius: 6px; background: rgba(255,255,255,0.04); }
            .mp-op-section:last-child { margin-bottom: 0; }
            .mp-op-section-title { font-weight: bold; font-size: 13px; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center; }
            .mp-op-issuance { border-left: 4px solid #e67e22; }
            .mp-op-templates { border-left: 4px solid #3498db; }
            .mp-op-refusal { border-left: 4px solid #e74c3c; display: none; }
            .mp-op-yandex { border-left: 4px solid #ffcc00; display: none; }
            .mp-op-cash { border-left: 4px solid #27ae60; }
            .mp-op-item { margin-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.12); padding-bottom: 6px; }
            .mp-op-item:last-child { border-bottom: none; margin-bottom: 0; padding-bottom: 0; }
            .mp-op-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; }
            .mp-op-btn { background: #2980b9; color: #fff; border: none; padding: 9px 8px; border-radius: 4px; font-weight: bold; cursor: pointer; text-align: center; font-size: 12px; transition: background 0.2s; }
            .mp-op-btn:hover { background: #1f618d; }
            .mp-op-btn.mp-op-danger { background: #e74c3c; }
            .mp-op-btn.mp-op-danger:hover { background: #c0392b; }
            .mp-op-btn.mp-op-ozon { background: #005bff; grid-column: span 2; }
            .mp-op-btn.mp-op-ozon:hover { background: #003db3; }
            .mp-op-refusal-row { display: flex; align-items: center; margin-bottom: 8px; gap: 5px; }
            .mp-op-refusal-row input { flex: 1; padding: 6px; border-radius: 4px; border: 1px solid #ccc; font-size: 12px; }
            .mp-op-refusal-add-btn, .mp-op-refusal-del-btn { border: none; width: 28px; height: 28px; border-radius: 4px; font-weight: bold; cursor: pointer; font-size: 14px; color: #fff; flex-shrink: 0; }
            .mp-op-refusal-add-btn { background: #27ae60; }
            .mp-op-refusal-add-btn:hover { background: #219653; }
            .mp-op-refusal-del-btn { background: #c0392b; }
            .mp-op-refusal-del-btn:hover { background: #a93226; }
            .mp-op-refusal-actions { display: flex; gap: 6px; margin-top: 10px; }
            .mp-op-refusal-actions button { flex: 1; background: #2980b9; color: #fff; border: none; padding: 8px; border-radius: 4px; font-weight: bold; cursor: pointer; font-size: 11px; text-align: center; }
            .mp-op-refusal-actions button:hover { background: #1f618d; }
            .mp-op-close-x { cursor: pointer; font-size: 14px; opacity: 0.8; }
            .mp-op-close-x:hover { opacity: 1; }
            .mp-op-yandex-row { display: flex; align-items: center; margin-bottom: 8px; gap: 5px; }
            .mp-op-yandex-row input { flex: 1; padding: 6px; border-radius: 4px; border: 1px solid #ccc; font-size: 12px; }
            .mp-op-yandex-add-btn, .mp-op-yandex-del-btn { border: none; width: 28px; height: 28px; border-radius: 4px; font-weight: bold; cursor: pointer; font-size: 14px; color: #fff; flex-shrink: 0; }
            .mp-op-yandex-add-btn { background: #27ae60; }
            .mp-op-yandex-add-btn:hover { background: #219653; }
            .mp-op-yandex-del-btn { background: #c0392b; }
            .mp-op-yandex-del-btn:hover { background: #a93226; }
            .mp-op-yandex-actions { display: flex; gap: 6px; margin-top: 10px; }
            .mp-op-yandex-actions button { flex: 1; background: #d4a017; color: #fff; border: none; padding: 8px; border-radius: 4px; font-weight: bold; cursor: pointer; font-size: 11px; text-align: center; }
            .mp-op-yandex-actions button:hover { background: #b8860b; }
            .mp-op-yandex-choice { display: none; gap: 6px; margin-top: 10px; }
            .mp-op-yandex-choice button { flex: 1; border: none; padding: 8px; border-radius: 4px; font-weight: bold; cursor: pointer; font-size: 11px; color: #fff; }
            .mp-op-yandex-choice button[data-role="client"] { background: #2980b9; }
            .mp-op-yandex-choice button[data-role="client"]:hover { background: #1f618d; }
            .mp-op-yandex-choice button[data-role="employee"] { background: #8e44ad; }
            .mp-op-yandex-choice button[data-role="employee"]:hover { background: #703688; }
            .mp-op-yandex-choice button[data-role="cancel"] { background: #7f8c8d; }
            .mp-op-yandex-choice button[data-role="cancel"]:hover { background: #626d6e; }
            .mp-op-btn.mp-op-yandex-toggle { background: #ffcc00; color: #1f1f1f; }
            .mp-op-btn.mp-op-yandex-toggle:hover { background: #e6b800; }
            .mp-op-cash-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
            .mp-op-cash-btn { background: #27ae60; color: #fff; border: none; padding: 8px 6px; border-radius: 4px; font-weight: bold; cursor: pointer; text-align: center; font-size: 11px; transition: background 0.2s; }
            .mp-op-cash-btn:hover { background: #219653; }
            #mp-op-footer { padding: 12px 16px; background: #1f2c38; border-top: 1px solid rgba(255,255,255,0.12); flex-shrink: 0; }
            #mp-op-execute-btn { width: 100%; background: #198754; color: #fff; border: none; padding: 13px; border-radius: 6px; font-weight: bold; font-size: 15px; cursor: pointer; transition: background 0.2s; }
            #mp-op-execute-btn:hover { background: #157347; }
        `;
        document.head.appendChild(style);

        const panel = document.createElement('div');
        panel.id = 'mp-order-panel';

        let bodyHtml = '';
        if (showIssuance) {
            bodyHtml += `
                <div class="mp-op-section mp-op-issuance" id="mp-op-issuance-section">
                    <div class="mp-op-section-title">📦 Активная выдача</div>
                    <div id="mp-op-issuance-content">Поиск элементов...</div>
                </div>
            `;
        }
        if (showTemplates || showOzon) {
            bodyHtml += `
                <div class="mp-op-section mp-op-templates" id="mp-op-templates-section">
                    <div class="mp-op-section-title">🧮 Способ расчёта / Комментарий</div>
                    <div class="mp-op-grid">
                        ${showTemplates ? `
                            <button class="mp-op-btn" data-type="employee">Сотрудник</button>
                            <button class="mp-op-btn" data-type="svo">Сво</button>
                            <button class="mp-op-btn" data-type="flyer">Флаер</button>
                            <button class="mp-op-btn mp-op-danger" data-type="refusal">Отказ</button>
                            <button class="mp-op-btn mp-op-yandex-toggle" data-type="yandex">📮 ЯМ выдача</button>
                        ` : ''}
                        ${showOzon ? `<button class="mp-op-btn mp-op-ozon" data-type="free_ozon">💙 Бесплатный озон</button>` : ''}
                    </div>
                </div>
            `;
        }
        if (showTemplates) {
            bodyHtml += `
                <div class="mp-op-section mp-op-refusal" id="mp-op-refusal-section">
                    <div class="mp-op-section-title">
                        <span>❌ Позиции для отказа</span>
                        <span class="mp-op-close-x" id="mp-op-refusal-close">✕</span>
                    </div>
                    <div id="mp-op-refusal-inputs">
                        <div class="mp-op-refusal-row">
                            <input type="number" placeholder="Сумма позиции" class="mp-op-refusal-val" />
                            <button class="mp-op-refusal-add-btn">+</button>
                        </div>
                    </div>
                    <div class="mp-op-refusal-actions">
                        <button id="mp-op-refusal-standard">Посчитать</button>
                        <button id="mp-op-refusal-employee">Посчитать (сотрудник)</button>
                    </div>
                </div>

                <div class="mp-op-section mp-op-yandex" id="mp-op-yandex-section">
                    <div class="mp-op-section-title">
                        <span>📮 Яндекс Маркет — выкуп</span>
                        <span class="mp-op-close-x" id="mp-op-yandex-close">✕</span>
                    </div>
                    <div id="mp-op-yandex-inputs">
                        <div class="mp-op-yandex-row">
                            <input type="number" placeholder="Сумма выкупа" class="mp-op-yandex-val" />
                            <button class="mp-op-yandex-add-btn">+</button>
                        </div>
                    </div>
                    <div class="mp-op-yandex-actions">
                        <button id="mp-op-yandex-issue">📤 Выдача</button>
                        <button id="mp-op-yandex-refusal">❌ Отказ (частичный/полный)</button>
                    </div>
                    <div class="mp-op-yandex-choice" id="mp-op-yandex-choice">
                        <button data-role="client">Клиент (10%)</button>
                        <button data-role="employee">Сотрудник (5%)</button>
                        <button data-role="cancel">Отмена</button>
                    </div>
                </div>
            `;
        }
        if (showCash) {
            bodyHtml += `
                <div class="mp-op-section mp-op-cash" id="mp-op-cash-section">
                    <div class="mp-op-section-title">💵 Касса (способ оплаты)</div>
                    <div class="mp-op-cash-grid">
                        <button class="mp-op-cash-btn" data-payment="cash">Наличные</button>
                        <button class="mp-op-cash-btn" data-payment="card">Карта</button>
                        <button class="mp-op-cash-btn" data-payment="qr">QR-код</button>
                    </div>
                </div>
            `;
        }

        panel.innerHTML = `
            <div id="mp-op-header">
                <span>🎛️ Панель выдачи заказа</span>
            </div>
            <div id="mp-op-body">${bodyHtml}</div>
            <div id="mp-op-footer">
                <button id="mp-op-execute-btn">✅ Провести</button>
            </div>
        `;
        document.body.appendChild(panel);

        const headerEl = panel.querySelector('#mp-op-header');
        const panelStateKey = 'mp_order_panel_state';
        let savedState = GM_getValue(panelStateKey, null);

        panel.style.display = 'flex';

        if (savedState) {
            panel.style.left = savedState.left + 'px';
            panel.style.top = savedState.top + 'px';
            panel.style.width = savedState.width + 'px';
            if (savedState.height) panel.style.height = savedState.height + 'px';
        } else {
            panel.style.width = '370px';
            const rect = panel.getBoundingClientRect();
            const defaultLeft = window.innerWidth - rect.width - 20;
            const defaultTop = window.innerHeight - rect.height - 20;
            panel.style.left = Math.max(10, defaultLeft) + 'px';
            panel.style.top = Math.max(10, defaultTop) + 'px';

            GM_setValue(panelStateKey, { top: parseFloat(panel.style.top), left: parseFloat(panel.style.left), width: rect.width, height: rect.height });
        }

        function savePanelState() {
            const rect = panel.getBoundingClientRect();
            GM_setValue(panelStateKey, { top: rect.top, left: rect.left, width: rect.width, height: rect.height });
        }

        let isDragging = false, dragOffsetX = 0, dragOffsetY = 0;
        headerEl.addEventListener('mousedown', (e) => {
            isDragging = true;
            const rect = panel.getBoundingClientRect();
            panel.style.left = rect.left + 'px';
            panel.style.top = rect.top + 'px';
            dragOffsetX = e.clientX - rect.left;
            dragOffsetY = e.clientY - rect.top;
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });

        function onMouseMove(e) {
            if (!isDragging) return;
            panel.style.left = Math.max(0, e.clientX - dragOffsetX) + 'px';
            panel.style.top = Math.max(0, e.clientY - dragOffsetY) + 'px';
        }

        function onMouseUp() {
            if (isDragging) {
                isDragging = false;
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
                savePanelState();
            }
        }

        new ResizeObserver(() => { if (!isDragging) savePanelState(); }).observe(panel);

        function getMpShortText() {
            let rawMpText = '';
            const contentDiv = document.querySelector('div#content');
            if (contentDiv) rawMpText = contentDiv.innerText || '';
            const cleanText = rawMpText.toLowerCase().replace(/[\s\n\r;.,:()\-_]+/g, '');
            const mpDictionary = [
                { keys: ['wildberries', 'вайлдберриз', 'вб'], short: 'ВБ' },
                { keys: ['ozon', 'озон'], short: 'O-н' },
                { keys: ['avito', 'авито'], short: 'Авито' },
                { keys: ['золотоеяблоко', 'зя'], short: 'ЗЯ' },
                { keys: ['яндексмаркет', 'ям'], short: 'ЯМ' },
                { keys: ['крупногабарит', 'кг'], short: 'КГ' }
            ];
            let mpShort = 'Другое';
            for (const entry of mpDictionary) {
                for (const key of entry.keys) {
                    if (cleanText.includes(key)) { mpShort = entry.short; break; }
                }
                if (mpShort !== 'Другое') break;
            }
            return mpShort;
        }

        function getParsedHeaderData() {
            const heading = document.querySelector('h2.box-heading');
            let headingText = heading ? heading.innerText : '';
            let nz = headingText.includes('Выдача заказа PVZ ДонКлик № ')
                ? headingText.replace('Выдача заказа PVZ ДонКлик № ', '').trim()
                : headingText.replace(/Выдача заказа PVZ ДонКлик/gi, '').trim();

            let kf = 0;
            let match1 = headingText.match(/№\s*[\d\-]+\s*-\s*(\d+)\s*товаров/i);
            if (match1) { kf = parseInt(match1[1]) || 0; }
            else {
                let match2 = headingText.match(/\|\s*(\d+)т$/i);
                if (match2) { kf = parseInt(match2[1]) || 0; }
                else {
                    let parts = headingText.split('-');
                    if (parts.length > 1) {
                        let lastPart = parts[parts.length - 1].replace('товаров', '').replace('т', '').trim();
                        kf = parseInt(lastPart) || 1;
                    } else { kf = 1; }
                }
            }
            return { nz, kf };
        }

        function setCommentValue(text) {
            navigator.clipboard.writeText(text).then(() => showNotification(`📋 Скопировано: ${text}`));
            const targetInput = document.querySelector('form[action*="parcel/handover"] > input:nth-of-type(5), form[action*="parcel/handover"] input[name="comment"]');
            if (targetInput) {
                targetInput.value = text;
                targetInput.dispatchEvent(new Event('input', { bubbles: true }));
                targetInput.dispatchEvent(new Event('change', { bubbles: true }));
            } else {
                const backupInput = document.querySelector('input[name*="comment"], textarea[name*="comment"]');
                if (backupInput) {
                    backupInput.value = text;
                    backupInput.dispatchEvent(new Event('input', { bubbles: true }));
                }
            }
        }

        let foundIssuanceItems = [];
        let lastPaymentMethod = 'cash';

        function populateIssuanceSection() {
            const itemHistory = GM_getValue('mp_item_history', {});
            const searchElements = document.querySelectorAll('[barcode], [data-barcode], input[type="checkbox"], input[name="packages"]');

            searchElements.forEach(el => {
                const barcode = el.getAttribute('barcode') || el.getAttribute('data-barcode') || el.value;
                if (barcode && itemHistory[barcode] && !itemHistory[barcode].issuedAt &&
                    itemHistory[barcode].status !== 'выдан' && itemHistory[barcode].status !== 'выдача') {
                    if (!foundIssuanceItems.some(i => i.barcode === barcode)) {
                        foundIssuanceItems.push(itemHistory[barcode]);
                    }
                }
            });

            const contentEl = document.getElementById('mp-op-issuance-content');
            if (!contentEl) return;

            if (foundIssuanceItems.length > 0) {
                let html = '';
                foundIssuanceItems.forEach((item, idx) => {
                    html += `
                        <div class="mp-op-item">
                            <b>Элемент ${idx + 1}: <code>${item.barcode}</code></b><br>
                            <span style="color:#2ecc71; font-weight:bold;">Ячейка: ${item.cell}</span><br>
                            <span style="font-size:11px; color:#cbd5e1; white-space:pre-line;">${item.info}</span>
                        </div>
                    `;
                });
                contentEl.innerHTML = html;
            } else {
                contentEl.innerHTML = '<i>Нет активных элементов на хранении для этой выдачи</i>';
            }
        }

        function wireTemplateButtons() {
            panel.querySelectorAll('.mp-op-btn[data-type]').forEach(btn => {
                const type = btn.getAttribute('data-type');
                if (type === 'refusal') {
                    btn.onclick = () => {
                        const section = document.getElementById('mp-op-refusal-section');
                        if (section) section.style.display = section.style.display === 'block' ? 'none' : 'block';
                    };
                    return;
                }
                if (type === 'yandex') {
                    btn.onclick = () => {
                        const section = document.getElementById('mp-op-yandex-section');
                        if (section) section.style.display = section.style.display === 'block' ? 'none' : 'block';
                    };
                    return;
                }
                if (type === 'free_ozon') return;

                btn.onclick = () => {
                    const heading = document.querySelector('h2.box-heading');
                    let orderNum = heading ? heading.innerText.replace(/Выдача заказа PVZ ДонКлик/gi, '').replace(/товаров/gi, '').trim() : '';
                    const amountInput = document.querySelector('input[name="amount"]');
                    let sumSot = amountInput ? Math.ceil((parseFloat(amountInput.value) || 0) / 2) : 0;
                    const mpShort = getMpShortText();

                    let resultComment = '';
                    if (type === 'employee') resultComment = `${orderNum} товаров ${mpShort} выдано, взято ${sumSot}р, 5%, сотрудник`;
                    else if (type === 'svo') resultComment = `${orderNum} товаров ${mpShort} выдано, взято ${sumSot}р, 5%, сво`;
                    else if (type === 'flyer') resultComment = `${orderNum} товаров ${mpShort} выдано, взято 0р, флаер`;

                    setCommentValue(resultComment);
                };
            });
        }

        function wireRefusalPanel() {
            const inputsContainer = document.getElementById('mp-op-refusal-inputs');
            const closeBtn = document.getElementById('mp-op-refusal-close');
            if (!inputsContainer) return;

            function updateRowButtons() {
                const rows = inputsContainer.querySelectorAll('.mp-op-refusal-row');
                rows.forEach((row, index) => {
                    let btn = row.querySelector('button');
                    if (index === rows.length - 1) {
                        btn.className = 'mp-op-refusal-add-btn';
                        btn.innerText = '+';
                        btn.onclick = () => {
                            const newRow = document.createElement('div');
                            newRow.className = 'mp-op-refusal-row';
                            newRow.innerHTML = `<input type="number" placeholder="Сумма позиции" class="mp-op-refusal-val" /><button class="mp-op-refusal-add-btn">+</button>`;
                            inputsContainer.appendChild(newRow);
                            updateRowButtons();
                        };
                    } else {
                        btn.className = 'mp-op-refusal-del-btn';
                        btn.innerText = '✕';
                        btn.onclick = () => { row.remove(); updateRowButtons(); };
                    }
                });
            }
            updateRowButtons();

            if (closeBtn) closeBtn.onclick = () => { const s = document.getElementById('mp-op-refusal-section'); if (s) s.style.display = 'none'; };

            function executeRefusalCalculation(isEmployeeType) {
                const inputs = inputsContainer.querySelectorAll('.mp-op-refusal-val');
                let sumValues = 0, koCount = 0;
                inputs.forEach(input => {
                    let val = parseFloat(input.value);
                    if (!isNaN(val) && val > 0) { sumValues += val; koCount++; }
                });

                if (koCount === 0) { alert('Введите хотя бы одну сумму для позиций отказа!'); return; }

                const { nz, kf } = getParsedHeaderData();
                const kv = kf - koCount;
                const sd = sumValues * 0.10;
                const sds = sumValues * 0.05;
                const mpShort = getMpShortText();
                const amountInput = document.querySelector('input[name="amount"]');
                let baseSum = amountInput ? (parseFloat(amountInput.value) || 0) : 0;
                let sumSot = Math.ceil(baseSum / 2);

                let resultComment = '';
                if (kf <= koCount) {
                    resultComment = `${nz} товаров ${mpShort} выдано 0 из ${kf}, взято 0р, полный отказ на месте`;
                } else {
                    if (!isEmployeeType) {
                        let finalTaken = Math.max(0, Math.round(baseSum - sd));
                        resultComment = `${nz} товаров ${mpShort} выдано ${kv} из ${kf}, взято ${finalTaken}р, частичный отказ на месте`;
                    } else {
                        let finalTakenSds = Math.max(0, Math.round(sumSot - sds));
                        resultComment = `${nz} товаров ${mpShort} выдано ${kv} из ${kf}, взято ${finalTakenSds}р, частичный отказ на месте (сотрудник)`;
                    }
                }
                setCommentValue(resultComment);
                const s = document.getElementById('mp-op-refusal-section');
                if (s) s.style.display = 'none';
            }

            const stdBtn = document.getElementById('mp-op-refusal-standard');
            const empBtn = document.getElementById('mp-op-refusal-employee');
            if (stdBtn) stdBtn.onclick = () => executeRefusalCalculation(false);
            if (empBtn) empBtn.onclick = () => executeRefusalCalculation(true);
        }

        function wireYandexPanel() {
            const inputsContainer = document.getElementById('mp-op-yandex-inputs');
            const closeBtn = document.getElementById('mp-op-yandex-close');
            const choiceBox = document.getElementById('mp-op-yandex-choice');
            if (!inputsContainer) return;
            let pendingYandexAction = null;

            function updateRowButtons() {
                const rows = inputsContainer.querySelectorAll('.mp-op-yandex-row');
                rows.forEach((row, index) => {
                    let btn = row.querySelector('button');
                    if (index === rows.length - 1) {
                        btn.className = 'mp-op-yandex-add-btn';
                        btn.innerText = '+';
                        btn.onclick = () => {
                            const newRow = document.createElement('div');
                            newRow.className = 'mp-op-yandex-row';
                            newRow.innerHTML = `<input type="number" placeholder="Сумма выкупа" class="mp-op-yandex-val" /><button class="mp-op-yandex-add-btn">+</button>`;
                            inputsContainer.appendChild(newRow);
                            updateRowButtons();
                        };
                    } else {
                        btn.className = 'mp-op-yandex-del-btn';
                        btn.innerText = '✕';
                        btn.onclick = () => { row.remove(); updateRowButtons(); };
                    }
                });
            }
            updateRowButtons();

            if (closeBtn) {
                closeBtn.onclick = () => {
                    const s = document.getElementById('mp-op-yandex-section');
                    if (s) s.style.display = 'none';
                    if (choiceBox) choiceBox.style.display = 'none';
                    pendingYandexAction = null;
                };
            }

            function getYandexInputData() {
                const inputs = inputsContainer.querySelectorAll('.mp-op-yandex-val');
                let sum = 0, filledCount = 0;
                inputs.forEach(input => {
                    const val = parseFloat(input.value);
                    if (!isNaN(val) && val > 0) { sum += val; filledCount++; }
                });
                return { sum, filledCount };
            }

            function finalizeYandex(role) {
                const percent = role === 'employee' ? 5 : 10;
                const { sum, filledCount } = getYandexInputData();
                const { nz, kf } = getParsedHeaderData();
                let resultComment = '';

                if (pendingYandexAction === 'issue') {
                    const taken = Math.round(sum * percent / 100);
                    resultComment = `${nz} товаров ЯМ выдано, взято ${taken}р`;
                } else if (pendingYandexAction === 'refusal') {
                    if (filledCount === 0) {
                        resultComment = `${nz} товаров ЯМ выдано 0 из ${kf}, взято 0р, полный отказ на месте`;
                    } else {
                        const taken = Math.round(sum * percent / 100);
                        resultComment = `${nz} товаров ЯМ выдано ${filledCount} из ${kf}, взято ${taken}р, частичный отказ на месте`;
                    }
                }
                if (resultComment) setCommentValue(resultComment);
                if (choiceBox) choiceBox.style.display = 'none';
                const s = document.getElementById('mp-op-yandex-section');
                if (s) s.style.display = 'none';
                pendingYandexAction = null;
            }

            const issueBtn = document.getElementById('mp-op-yandex-issue');
            const refusalBtn = document.getElementById('mp-op-yandex-refusal');
            if (issueBtn) issueBtn.onclick = () => { pendingYandexAction = 'issue'; if (choiceBox) choiceBox.style.display = 'flex'; };
            if (refusalBtn) refusalBtn.onclick = () => { pendingYandexAction = 'refusal'; if (choiceBox) choiceBox.style.display = 'flex'; };

            if (choiceBox) {
                choiceBox.querySelectorAll('button[data-role]').forEach(btn => {
                    const role = btn.getAttribute('data-role');
                    btn.onclick = () => {
                        if (role === 'cancel') { choiceBox.style.display = 'none'; pendingYandexAction = null; return; }
                        finalizeYandex(role);
                    };
                });
            }
        }

        function wireOzonButton() {
            const btn = panel.querySelector('.mp-op-btn[data-type="free_ozon"]');
            if (!btn) return;
            btn.onclick = () => {
                const heading = document.querySelector('h2.box-heading');
                let orderNum = heading ? heading.innerText.replace(/Выдача заказа PVZ ДонКлик/gi, '').replace(/товаров/gi, '').trim() : '';
                const mpShort = getMpShortText();
                if (mpShort !== 'O-н') { alert('Ошибка: это не озон!'); return; }
                setCommentValue(`${orderNum} товаров ${mpShort} выдано, взято 0р, бесплатный озон`);
            };
        }

        function wireCashButtons() {
            function getBaseSumValue() {
                const totalInput = document.querySelector('input[type="text"].dark[name="total"]');
                if (!totalInput) return 0;
                let val = parseFloat(totalInput.value);
                return isNaN(val) ? 0 : val;
            }

            function executeCheckboxes() {
                const checkboxes = document.querySelectorAll('input[type="checkbox"].checkbox + label::before, input[type="checkbox"].checkbox');
                checkboxes.forEach(el => {
                    const cb = el.tagName === 'INPUT' ? el : document.querySelector(`input[id="${el.getAttribute('for')}"]`) || el.previousElementSibling;
                    if (cb && cb.type === 'checkbox' && !cb.checked) {
                        cb.checked = true;
                        cb.dispatchEvent(new Event('change', { bubbles: true }));
                        cb.dispatchEvent(new Event('input', { bubbles: true }));
                    } else if (el.tagName !== 'INPUT') {
                        el.click();
                    }
                });
            }

            panel.querySelectorAll('.mp-op-cash-btn').forEach(btn => {
                const paymentType = btn.getAttribute('data-payment');
                btn.onclick = () => {
                    lastPaymentMethod = paymentType;
                    executeCheckboxes();

                    if (paymentType === 'cash') {
                        const cashLabel = document.querySelector('label[for="cash"]');
                        if (cashLabel) cashLabel.click();
                        else {
                            const cashRadio = document.querySelector('input[type="radio"]#cash, input[name="payment"][value="cash"], #cash');
                            if (cashRadio) { cashRadio.checked = true; cashRadio.dispatchEvent(new Event('change', { bubbles: true })); cashRadio.dispatchEvent(new Event('click', { bubbles: true })); }
                        }
                        const baseSum = getBaseSumValue();
                        const amountInput = document.querySelector('input[type="text"].dark.amount[maxlength="96"][name="total_amount"]');
                        if (amountInput) {
                            amountInput.value = baseSum;
                            amountInput.dispatchEvent(new Event('input', { bubbles: true }));
                            amountInput.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                        showNotification('💵 Выбрано: Наличные, сумма введена');
                    } else if (paymentType === 'card') {
                        const cardLabel = document.querySelector('label[for="card"]');
                        if (cardLabel) cardLabel.click();
                        else {
                            const cardRadio = document.querySelector('input[type="radio"]#card, input[name="payment"][value="card"], #card');
                            if (cardRadio) { cardRadio.checked = true; cardRadio.dispatchEvent(new Event('change', { bubbles: true })); cardRadio.dispatchEvent(new Event('click', { bubbles: true })); }
                        }
                        showNotification('💳 Выбрано: Картой');
                    } else if (paymentType === 'qr') {
                        const qrLabel = document.querySelector('label[for="qr"]');
                        if (qrLabel) qrLabel.click();
                        else {
                            const qrRadio = document.querySelector('input[type="radio"]#qr, input[name="payment"][value="qr"], #qr');
                            if (qrRadio) { qrRadio.checked = true; qrRadio.dispatchEvent(new Event('change', { bubbles: true })); qrRadio.dispatchEvent(new Event('click', { bubbles: true })); }
                        }
                        showNotification('📱 Выбрано: QR-код');
                    }
                };
            });
        }

        function wireExecuteButton(executeBtn) {
            const btn = document.getElementById('mp-op-execute-btn');
            if (!btn) return;

            function getIssuedAmount() {
                const commentInput = document.querySelector('form[action*="parcel/handover"] input[name="comment"], form[action*="parcel/handover"] textarea[name="comment"]') ||
                    document.querySelector('input[name*="comment"], textarea[name*="comment"]');
                if (commentInput && commentInput.value) {
                    const match = commentInput.value.match(/взято\s*([\d]+(?:[.,]\d+)?)\s*р/i);
                    if (match) return parseFloat(match[1].replace(',', '.')) || 0;
                }
                const totalInput = document.querySelector('input[type="text"].dark[name="total"]');
                return totalInput ? (parseFloat(totalInput.value) || 0) : 0;
            }

            btn.onclick = () => {
                if (showIssuance && foundIssuanceItems.length > 0) {
                    const itemHistory = GM_getValue('mp_item_history', {});
                    let occupiedCells = GM_getValue('mp_occupied_cells', {});

                    foundIssuanceItems.forEach(item => {
                        if (itemHistory[item.barcode]) {
                            itemHistory[item.barcode].status = 'выдан';
                            itemHistory[item.barcode].issuedAt = new Date().toLocaleString();
                        }

                        let cellName = item.cell;
                        let cellsToRelease = cellName.endsWith('+г') ? [cellName, cellName.replace('+г', '')] : [cellName];
                        cellsToRelease.forEach(cName => {
                            if (occupiedCells[cName]) {
                                occupiedCells[cName].count = Math.max(0, occupiedCells[cName].count - 1);
                                if (occupiedCells[cName].items) occupiedCells[cName].items = occupiedCells[cName].items.filter(i => i.barcode !== item.barcode);
                                if (occupiedCells[cName].count === 0) delete occupiedCells[cName];
                            }
                        });
                    });

                    GM_setValue('mp_item_history', itemHistory);
                    GM_setValue('mp_occupied_cells', occupiedCells);

                    // СИНХРОНИЗАЦИЯ ПОСЛЕДОВАТЕЛЬНО
                    syncNpointItems();
                    syncNpointCells();

                    showNotification('✅ Заказ проведен, ячейки освобождены!');
                } else {
                    showNotification('✅ Заказ проведен!');
                }

                if (showCash) {
                    const amount = getIssuedAmount();
                    const heading = document.querySelector('h2.box-heading');
                    const orderNum = heading ? heading.innerText.replace(/Выдача заказа PVZ ДонКлик/gi, '').replace(/товаров/gi, '').trim() : '';
                    recordCashTransaction(amount, lastPaymentMethod, orderNum);
                }

                executeBtn.click();
            };
        }

        if (showIssuance) populateIssuanceSection();
        if (showTemplates) wireTemplateButtons();
        if (showOzon) wireOzonButton();
        if (showTemplates) wireRefusalPanel();
        if (showTemplates) wireYandexPanel();
        if (showCash) wireCashButtons();

        wireExecuteButton(executeBtn);
    }

    // ==========================================
    // 6. МОДУЛЬ: ОСНОВА (История + Менеджер + Касса)
    // ==========================================
    function initBaseModule() {
        showNotification('🏠 Запущен модуль: ОСНОВА');

        if (!document.getElementById('mp-history-style')) {
            const histStyle = document.createElement('style');
            histStyle.id = 'mp-history-style';
            histStyle.innerHTML = `
                #mp-history-modal, #mp-manager-modal, #mp-cash-modal {
                    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
                    background: #ffffff; padding: 25px; border-radius: 8px; z-index: 30000;
                    box-shadow: 0 10px 30px rgba(0,0,0,0.5); display: none;
                    width: 650px; font-family: sans-serif; max-height: 85vh; overflow-y: auto; color: #333;
                }
                .mp-history-table { width: 100%; border-collapse: collapse; margin-top: 15px; font-size: 13px; }
                .mp-history-table th, .mp-history-table td { border: 1px solid #dee2e6; padding: 8px 10px; text-align: left; }
                .mp-history-table th { background: #f8f9fa; font-weight: bold; }
                .badge-storage { background: #d1e7dd; color: #0f5132; padding: 3px 8px; border-radius: 4px; font-weight: bold; font-size: 11px; }
                .badge-issued { background: #f8d7da; color: #842029; padding: 3px 8px; border-radius: 4px; font-weight: bold; font-size: 11px; }
                .mp-cash-stat-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 16px; }
                .mp-cash-stat-box { background: #f8f9fa; border-radius: 6px; padding: 10px; border-left: 4px solid #27ae60; }
                .mp-cash-stat-box .label { font-size: 11px; color: #666; margin-bottom: 4px; }
                .mp-cash-stat-box .value { font-size: 17px; font-weight: bold; color: #198754; }
                .mp-cash-section { margin-top: 18px; padding-top: 14px; border-top: 1px solid #eee; }
                .mp-cash-section h3 { font-size: 14px; margin: 0 0 10px 0; }
                .mp-cash-period-row { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
                .mp-cash-period-row input { padding: 6px; border: 1px solid #ccc; border-radius: 4px; font-size: 12px; }
                .mp-cash-btn { background: #2980b9; color: #fff; border: none; padding: 8px 14px; border-radius: 4px; font-weight: bold; cursor: pointer; font-size: 12px; }
                .mp-cash-btn:hover { background: #1f618d; }
                .mp-cash-btn.danger { background: #dc3545; }
                .mp-cash-btn.danger:hover { background: #b02a37; }
                .mp-cash-admin-box { background: #fff8e1; border: 1px dashed #ffc107; border-radius: 6px; padding: 12px; margin-top: 12px; }
                #mp-manager-btn { position: fixed; top: 10px; right: 10px; z-index: 99999; background: #343a40; color: #fff; border: 1px solid rgba(255,255,255,0.2); padding: 6px 12px; border-radius: 4px; font-size: 12px; font-weight: bold; cursor: pointer; opacity: 0.2; transition: opacity 0.3s ease; }
                #mp-manager-btn:hover { opacity: 0.9; }
                .mp-manager-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; font-size: 14px; padding-bottom: 8px; border-bottom: 1px solid #eee; }
            `;
            document.head.appendChild(histStyle);

            const histModal = document.createElement('div');
            histModal.id = 'mp-history-modal';
            document.body.appendChild(histModal);

            const managerModal = document.createElement('div');
            managerModal.id = 'mp-manager-modal';
            document.body.appendChild(managerModal);

            const cashModal = document.createElement('div');
            cashModal.id = 'mp-cash-modal';
            document.body.appendChild(cashModal);
        }

        if (!document.getElementById('mp-manager-btn')) {
            const managerBtn = document.createElement('button');
            managerBtn.id = 'mp-manager-btn';
            managerBtn.innerText = '⚙️ Менеджер модулей';
            managerBtn.onclick = () => requireAdmin(() => openManagerModal());
            document.body.appendChild(managerBtn);
        }

        const boxCategory = document.querySelector('.box-category');
        if (boxCategory) {
            if (!document.getElementById('mp-history-btn')) {
                const liHistory = document.createElement('li');
                liHistory.id = 'mp-history-btn';
                liHistory.style.cssText = 'position: relative; line-height: 45px; border-bottom: 2px solid #fff; cursor: pointer;';
                liHistory.innerHTML = `<a style="text-decoration: none; color: #333; display: block; padding-left: 15px; font-weight: bold;">📦 История ячеек</a>`;
                liHistory.onclick = (e) => { e.preventDefault(); openHistoryModal(); };
                boxCategory.appendChild(liHistory);
            }

            if (!document.getElementById('mp-box-cash-btn')) {
                const liCash = document.createElement('li');
                liCash.id = 'mp-box-cash-btn';
                liCash.style.cssText = 'position: relative; line-height: 45px; border-bottom: 2px solid #fff; cursor: pointer;';
                liCash.innerHTML = `<a style="text-decoration: none; color: #333; display: block; padding-left: 15px; font-weight: bold;">💵 Касса</a>`;
                liCash.onclick = (e) => { e.preventDefault(); openCashRegisterModal(); };
                boxCategory.appendChild(liCash);
            }
        }
    }

    function openHistoryModal() {
        const modal = document.getElementById('mp-history-modal');
        if (!modal) return;
        const itemHistory = GM_getValue('mp_item_history', {});
        let rows = '';
        const keys = Object.keys(itemHistory).reverse();

        if (keys.length === 0) {
            rows = '<tr><td colspan="5" style="text-align:center; color:#777;">История пуста</td></tr>';
        } else {
            keys.forEach(barcode => {
                const item = itemHistory[barcode];
                const statusBadge = item.status === 'выдан'
                    ? `<span class="badge-issued">Выдан (${item.issuedAt || ''})</span>`
                    : `<span class="badge-storage">На хранении (${item.acceptedAt || ''})</span>`;
                let actionBtn = '';
                if (item.status !== 'выдан') {
                    actionBtn = `<button onclick="window.mpManualIssue('${barcode}')" style="background:#27ae60; color:#fff; border:none; padding:3px 8px; border-radius:3px; cursor:pointer; font-size:11px;">Выдать</button>`;
                }
                rows += `
                    <tr>
                        <td><b>${barcode}</b></td>
                        <td>${item.cell || '-'}</td>
                        <td>${statusBadge}</td>
                        <td style="font-size:11px;">${item.info || ''}</td>
                        <td>${actionBtn}</td>
                    </tr>
                `;
            });
        }

        modal.innerHTML = `
            <button style="float:right; cursor:pointer; background:#dc3545; color:white; border:none; padding:6px 12px; border-radius:4px; font-weight:bold;" onclick="document.getElementById('mp-history-modal').style.display='none'">✕ Закрыть</button>
            <h2 style="margin-top:0; font-size:18px;">📦 История элементов и ячеек</h2>
            <div style="max-height:400px; overflow-y:auto; margin-top:15px;">
                <table class="mp-history-table">
                    <thead>
                        <tr>
                            <th>Штрихкод</th>
                            <th>Ячейка</th>
                            <th>Статус</th>
                            <th>Информация</th>
                            <th>Действие</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        `;
        modal.style.display = 'block';
    }

    function openManagerModal() {
        const modal = document.getElementById('mp-manager-modal');
        modal.innerHTML = `
            <button style="float:right; cursor:pointer; background:#dc3545; color:white; border:none; padding:6px 12px; border-radius:4px; font-weight:bold;" onclick="document.getElementById('mp-manager-modal').style.display='none'">✕ Закрыть</button>
            <h2 style="margin-top:0; font-size:18px;">⚙️ Менеджер модулей</h2>
            <p style="font-size: 13px; color: #666; margin-bottom: 20px;">Включайте или отключайте нужные модули скрипта.</p>
            <div class="mp-manager-row"><span>🚀 Модуль: Приём заказов</span><input type="checkbox" data-mod="acceptance" ${moduleSettings.acceptance ? 'checked' : ''} style="transform: scale(1.2);"></div>
            <div class="mp-manager-row"><span>📦 Модуль: Активная выдача</span><input type="checkbox" data-mod="issuance" ${moduleSettings.issuance ? 'checked' : ''} style="transform: scale(1.2);"></div>
            <div class="mp-manager-row"><span>🧮 Модуль: Автоподсчёт (комментарии)</span><input type="checkbox" data-mod="autocalc" ${moduleSettings.autocalc ? 'checked' : ''} style="transform: scale(1.2);"></div>
            <div class="mp-manager-row"><span>💙 Модуль: Автоподсчёт бесплатного озона</span><input type="checkbox" data-mod="freeOzon" ${moduleSettings.freeOzon ? 'checked' : ''} style="transform: scale(1.2);"></div>
            <div class="mp-manager-row"><span>💵 Модуль: Касса</span><input type="checkbox" data-mod="cash" ${moduleSettings.cash ? 'checked' : ''} style="transform: scale(1.2);"></div>
            <div class="mp-manager-row"><span>🏠 Модуль: Основа и история ячеек</span><input type="checkbox" data-mod="history" ${moduleSettings.history ? 'checked' : ''} style="transform: scale(1.2);"></div>
            <button id="mp-save-modules" style="width:100%; margin-top:15px; background:#198754; color:#fff; border:none; padding:10px; border-radius:5px; font-weight:bold; cursor:pointer;">Сохранить и перезагрузить</button>
        `;
        modal.style.display = 'block';

        modal.querySelector('#mp-save-modules').onclick = () => {
            modal.querySelectorAll('input[type="checkbox"]').forEach(chk => {
                const modName = chk.getAttribute('data-mod');
                moduleSettings[modName] = chk.checked;
            });
            saveModuleSettings();
            modal.style.display = 'none';
            showNotification('✅ Настройки сохранены! Перезагрузка...');
            setTimeout(() => window.location.reload(), 1000);
        };
    }

    function buildCashHistoryRows() {
        const transactions = GM_getValue('mp_cash_transactions', []);
        const encashments = GM_getValue('mp_cash_encashments', []);
        const adjustments = GM_getValue('mp_cash_adjustments', []);
        const methodLabels = { cash: 'наличные', card: 'карта', qr: 'QR-код' };
        let entries = [];

        transactions.forEach(t => entries.push({ timestamp: t.timestamp, type: 'Поступление', typeClass: 'in', amount: t.amount, comment: `${methodLabels[t.method] || t.method}${t.orderNum ? ', заказ ' + t.orderNum : ''}` }));
        encashments.forEach(e => entries.push({ timestamp: e.timestamp, type: 'Инкассация', typeClass: 'out', amount: -Math.abs(e.amount), comment: `Инкассация №${e.serial}` }));
        adjustments.forEach(a => entries.push({ timestamp: a.timestamp, type: a.amount >= 0 ? 'Корректировка (+)' : 'Корректировка (-)', typeClass: a.amount >= 0 ? 'in' : 'out', amount: a.amount, comment: a.note || '—' }));

        entries.sort((a, b) => b.timestamp - a.timestamp);
        entries = entries.slice(0, 200);

        if (entries.length === 0) return `<tr><td colspan="4" style="text-align:center; color:#777;">История пуста</td></tr>`;

        return entries.map(e => {
            const sign = e.amount >= 0 ? '+' : '';
            const colorStyle = e.typeClass === 'in' ? 'color:#198754;' : 'color:#dc3545;';
            return `
                <tr>
                    <td>${e.type}</td>
                    <td style="font-size:11px; white-space:nowrap;">${new Date(e.timestamp).toLocaleString()}</td>
                    <td style="${colorStyle} font-weight:bold; white-space:nowrap;">${sign}${e.amount.toFixed(2)}р</td>
                    <td style="font-size:12px;">${e.comment}</td>
                </tr>
            `;
        }).join('');
    }

    function computeCashTotals() {
        const dayRange = getTodayRange();
        const dayTotals = sumTransactionsInRange(dayRange.start, dayRange.end);
        const state = getCashState();
        const weekStart = state.lastEncashmentAt || getMondayOfWeek(Date.now());
        const weekTotals = sumTransactionsInRange(weekStart, Date.now());
        const allTimeTotals = sumTransactionsInRange(0, Date.now());
        const totalEncashmentsSum = GM_getValue('mp_cash_encashments', []).reduce((acc, e) => acc + e.amount, 0);
        const currentCashBalance = allTimeTotals.total - totalEncashmentsSum;
        return { dayTotals, weekTotals, currentCashBalance, state, weekStart };
    }

    function openCashRegisterModal() {
        renderCashModalContent();
        const modal = document.getElementById('mp-cash-modal');
        modal.style.display = 'block';
    }

    function renderCashModalContent() {
        const modal = document.getElementById('mp-cash-modal');
        if (!modal) return;

        const { dayTotals, weekTotals, currentCashBalance, state, weekStart } = computeCashTotals();

        modal.innerHTML = `
            <button style="float:right; cursor:pointer; background:#dc3545; color:white; border:none; padding:6px 12px; border-radius:4px; font-weight:bold;" onclick="document.getElementById('mp-cash-modal').style.display='none'">✕ Закрыть</button>
            <h2 style="margin-top:0; font-size:18px;">💵 Касса</h2>

            <div class="mp-cash-stat-grid">
                <div class="mp-cash-stat-box" style="border-left-color:#3498db;">
                    <div class="label">В кассе сейчас</div>
                    <div class="value" style="color:#3498db;">${currentCashBalance.toFixed(2)}р</div>
                </div>
                <div class="mp-cash-stat-box">
                    <div class="label">Касса за сегодня</div>
                    <div class="value">${dayTotals.total.toFixed(2)}р</div>
                </div>
                <div class="mp-cash-stat-box" style="border-left-color:#e67e22;">
                    <div class="label">Касса за неделю</div>
                    <div class="value" style="color:#e67e22;">${weekTotals.total.toFixed(2)}р</div>
                </div>
            </div>

            <div class="mp-cash-section">
                <h3>📅 Касса за выбранный период</h3>
                <div class="mp-cash-period-row">
                    <input type="datetime-local" id="mp-cash-period-from" />
                    <span>—</span>
                    <input type="datetime-local" id="mp-cash-period-to" />
                    <button class="mp-cash-btn" id="mp-cash-period-calc">Посчитать</button>
                </div>
                <div id="mp-cash-period-result" style="font-size:13px; margin-bottom:12px;"></div>
            </div>

            <div class="mp-cash-section">
                <h3>📥 Инкассация</h3>
                <p style="font-size:12px; color:#666; margin:0 0 8px 0;">
                    Текущий номер (ключ) инкассации: <b>№${state.encashmentSerial}</b><br>
                    Доступно по умолчанию с последней инкассации (или с понедельника): <b>${weekTotals.total.toFixed(2)}р</b>
                </p>
                <div class="mp-cash-period-row">
                    <span style="font-size:12px; font-weight:bold;">Период для инкассации:</span>
                    <input type="datetime-local" id="mp-cash-encash-from" />
                    <span>—</span>
                    <input type="datetime-local" id="mp-cash-encash-to" />
                    <button class="mp-cash-btn" id="mp-cash-encash-calc-btn">Рассчитать сумму периода</button>
                </div>
                <button class="mp-cash-btn" id="mp-cash-do-encashment" style="background:#198754; margin-top:4px;">Провести инкассацию</button>
            </div>

            <div class="mp-cash-section">
                <h3>📜 История поступлений/снятий</h3>
                <div style="max-height:220px; overflow-y:auto;">
                    <table class="mp-history-table" id="mp-cash-history-table">
                        <thead>
                            <tr>
                                <th>Тип операции</th>
                                <th>Время</th>
                                <th>Сумма</th>
                                <th>Комментарий</th>
                            </tr>
                        </thead>
                        <tbody>${buildCashHistoryRows()}</tbody>
                    </table>
                </div>
            </div>

            <div class="mp-cash-section">
                <button class="mp-cash-btn" id="mp-cash-admin-toggle" style="background:#6c757d;">🔑 Админ-функции</button>
                <div class="mp-cash-admin-box" id="mp-cash-admin-box" style="display:none;"></div>
            </div>
        `;

        const encashFromInput = modal.querySelector('#mp-cash-encash-from');
        const encashToInput = modal.querySelector('#mp-cash-encash-to');
        if (encashFromInput && encashToInput) {
            const dFrom = new Date(weekStart);
            const dTo = new Date();
            encashFromInput.value = new Date(dFrom.getTime() - dFrom.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
            encashToInput.value = new Date(dTo.getTime() - dTo.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
        }

        modal.querySelector('#mp-cash-period-calc').onclick = () => {
            const fromVal = modal.querySelector('#mp-cash-period-from').value;
            const toVal = modal.querySelector('#mp-cash-period-to').value;
            if (!fromVal || !toVal) { alert('Укажите начальную и конечную дату!'); return; }
            const totals = sumTransactionsInRange(new Date(fromVal).getTime(), new Date(toVal).getTime());
            modal.querySelector('#mp-cash-period-result').innerHTML = `<b>Итого за период:</b> ${totals.total.toFixed(2)}р (Нал: ${totals.cash.toFixed(2)}р, Карта: ${totals.card.toFixed(2)}р, QR: ${totals.qr.toFixed(2)}р)`;
        };

        modal.querySelector('#mp-cash-encash-calc-btn').onclick = () => {
            const fromVal = encashFromInput.value;
            const toVal = encashToInput.value;
            if (!fromVal || !toVal) { alert('Укажите обе даты периода!'); return; }
            const totals = sumTransactionsInRange(new Date(fromVal).getTime(), new Date(toVal).getTime());
            alert(`Сумма за период: ${totals.total.toFixed(2)}р (Наличные: ${totals.cash.toFixed(2)}р, Карта: ${totals.card.toFixed(2)}р, QR: ${totals.qr.toFixed(2)}р)`);
        };

        // ЛОГИКА ИНКАССАЦИИ
        modal.querySelector('#mp-cash-do-encashment').onclick = () => {
            requireAdmin(() => {
                const fromVal = encashFromInput.value;
                const toVal = encashToInput.value;
                let calculatedSum = weekTotals.total;

                if (fromVal && toVal) {
                    calculatedSum = sumTransactionsInRange(new Date(fromVal).getTime(), new Date(toVal).getTime()).total;
                }

                const suggested = calculatedSum.toFixed(2);
                const input = prompt('Сумма к инкассации (на основе выбранного периода):', suggested);
                if (input === null) return;
                const amount = parseFloat(input.replace(',', '.'));

                if (isNaN(amount) || amount <= 0) {
                    alert('Некорректная сумма!');
                    return;
                }

                const encashments = GM_getValue('mp_cash_encashments', []);
                encashments.push({
                    id: Date.now() + '_' + Math.random().toString(36).slice(2, 8),
                    timestamp: Date.now(),
                    amount: amount,
                    serial: state.encashmentSerial
                });
                GM_setValue('mp_cash_encashments', encashments);

                state.encashmentSerial += 1;
                state.lastEncashmentAt = Date.now();
                saveCashState(state); // Автоматически синхронизирует кассу с npoint

                showNotification(`✅ Инкассация №${state.encashmentSerial - 1} на сумму ${amount}р проведена`);
                renderCashModalContent();
            });
        };

        // Админ-панель внутри кассы
        modal.querySelector('#mp-cash-admin-toggle').onclick = () => {
            requireAdmin(() => {
                const adminBox = modal.querySelector('#mp-cash-admin-box');
                adminBox.style.display = adminBox.style.display === 'block' ? 'none' : 'block';
                adminBox.innerHTML = `
                    <h4 style="margin:0 0 10px 0;">✏️ Ручная корректировка кассы</h4>
                    <div style="display:flex; gap:6px; margin-bottom:10px;">
                        <input type="number" id="mp-adj-amount" placeholder="Сумма (+ или -)" style="width:120px; padding:4px;" />
                        <input type="text" id="mp-adj-note" placeholder="Причина / Комментарий" style="flex:1; padding:4px;" />
                        <button class="mp-cash-btn" id="mp-adj-btn">Добавить</button>
                    </div>
                `;
                adminBox.querySelector('#mp-adj-btn').onclick = () => {
                    const amt = parseFloat(adminBox.querySelector('#mp-adj-amount').value);
                    const note = adminBox.querySelector('#mp-adj-note').value;
                    if (amt) {
                        addManualCashAdjustment(amt, note);
                        renderCashModalContent();
                    }
                };
            });
        };
    }

    // ==========================================
    // ИНИЦИАЛИЗАЦИЯ
    // ==========================================
    const isBalancePage = window.location.href.includes('route=parcel/balance') || window.location.href.includes('route=parcel/handover');

    initBaseModule();
    initAcceptanceModule();
    initOrderPanelModule(isBalancePage);

})();
