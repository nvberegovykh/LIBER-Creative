// Invoice Generator Application with User-Specific Encryption
class InvoiceGenerator {
    constructor() {
        this.services = [];
        this.providers = [];
        this.clients = [];
        this.invoices = [];
        this.invoiceCounter = 1;
        this.currentServices = [];
        this.currentInvoiceId = null;
        this.userAuthenticated = false;
        
        this.checkAuthentication();
    }

    async checkAuthentication() {
        // Require Firebase to be initialized and a signed-in user
        let attempts = 0;
        while ((!window.firebaseService || !window.firebaseService.isInitialized) && attempts < 100) {
            await new Promise(r => setTimeout(r, 100));
            attempts++;
        }
        const authedUser = window.firebaseService && window.firebaseService.auth && window.firebaseService.auth.currentUser;
        if (!authedUser) {
            this.showAuthenticationError();
            return;
        }
        // Derive app key from uid if client-side encryption is desired
        window.invoiceCryptoManager.setUserKey(authedUser.uid);
        this.userAuthenticated = true;

        // Initialize the app
        this.initializeApp();
    }

    showAuthenticationError() {
        document.body.innerHTML = `
            <div style="
                display: flex;
                justify-content: center;
                align-items: center;
                height: 100vh;
                background: #000;
                color: white;
                font-family: Arial, sans-serif;
                text-align: center;
            ">
                <div>
                    <h2>Authentication Required</h2>
                    <p>Please log in to LIBER/APPS first.</p>
                    <p>This app requires user authentication to access encrypted data.</p>
                    <button onclick="window.close()" style="
                        background: #00d4ff;
                        color: white;
                        border: none;
                        padding: 10px 20px;
                        border-radius: 5px;
                        cursor: pointer;
                        margin-top: 20px;
                    ">Close</button>
                </div>
            </div>
        `;
    }

    async initializeApp() {
        if (!this.userAuthenticated) {
            return;
        }

        // Load data from Firestore
        await this.loadDataFromStore();
        
        // Set current date
        // A date input represents the user's calendar date, not the UTC date.
        // Keep the default consistent with the locally dated invoice number.
        const now = new Date();
        const today = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
        document.getElementById('invoiceDate').value = today;
        
        // Generate invoice ID
        await this.generateInvoiceId();
        
        // Add first service row
        this.addServiceRow();
        
        // Bind events
        this.bindEvents();
        
        // Load saved data
        this.loadSavedData();
        
        // Load issued invoices
        this.loadIssuedInvoices();
    }

    async loadDataFromStore() {
        try {
            const uid = window.firebaseService.auth.currentUser.uid;
            this.services = await window.invoiceStore.getServices(uid);
            this.providers = await window.invoiceStore.getProviders(uid);
            this.clients = await window.invoiceStore.getClients(uid);
            this.invoices = await window.invoiceStore.getInvoices(uid);
            this.invoiceCounter = await window.invoiceStore.getNextCounterPreview(uid);
        } catch (error) {
            console.error('Error loading data from store:', error);
            this.services = [];
            this.clients = [];
            this.invoices = [];
            this.invoiceCounter = 1;
        }
    }

    bindEvents() {
        // Tab navigation
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', (e) => this.switchTab(e.target.dataset.tab));
        });

        // Provider dropdown
        document.getElementById('providerDropdownBtn').addEventListener('click', () => {
            this.toggleProviderDropdown();
        });

        // Client dropdown
        document.getElementById('clientDropdownBtn').addEventListener('click', () => {
            this.toggleClientDropdown();
        });

        // Add service button
        document.getElementById('addServiceBtn').addEventListener('click', () => {
            this.addServiceRow();
        });

        // Save service button
        document.getElementById('saveServiceBtn').addEventListener('click', () => {
            this.saveService();
        });

        // Save provider button
        document.getElementById('saveProviderBtn').addEventListener('click', () => {
            this.saveProvider();
        });

        // Save client button
        document.getElementById('saveClientBtn').addEventListener('click', () => {
            this.saveClient();
        });

        // Generate PDF button
        document.getElementById('generatePdfBtn').addEventListener('click', () => {
            this.generatePDF();
        });

        // Preview button
        document.getElementById('previewBtn').addEventListener('click', () => {
            this.showPreview();
        });

        // Close preview modal
        document.getElementById('closePreviewBtn').addEventListener('click', () => {
            this.closePreview();
        });

        // Invoice search and filter
        document.getElementById('invoiceSearch').addEventListener('input', (e) => {
            this.filterInvoices();
        });

        document.getElementById('dateFilter').addEventListener('change', () => {
            this.filterInvoices();
        });

        // Close invoice details modal
        document.getElementById('closeInvoiceDetailsBtn').addEventListener('click', () => {
            this.closeInvoiceDetails();
        });

        // Download invoice button
        document.getElementById('downloadInvoiceBtn').addEventListener('click', () => {
            this.downloadInvoice();
        });

        // Delete invoice button
        document.getElementById('deleteInvoiceBtn').addEventListener('click', () => {
            this.deleteCurrentInvoice();
        });

        // Close modal when clicking outside
        document.getElementById('previewModal').addEventListener('click', (e) => {
            if (e.target.id === 'previewModal') {
                this.closePreview();
            }
        });

        document.getElementById('invoiceDetailsModal').addEventListener('click', (e) => {
            if (e.target.id === 'invoiceDetailsModal') {
                this.closeInvoiceDetails();
            }
        });

        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.input-with-dropdown')) {
                this.closeProviderDropdown();
                this.closeClientDropdown();
            }
        });
    }

    switchTab(tabName) {
        // Update active tab button
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.classList.remove('active');
        });
        document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');

        // Update active tab content
        document.querySelectorAll('.tab-content').forEach(content => {
            content.classList.remove('active');
        });
        document.getElementById(`${tabName}-tab`).classList.add('active');

        // Load data for specific tabs
        if (tabName === 'issued') {
            this.loadIssuedInvoices();
        }
    }

    async generateInvoiceId() {
        const date = new Date();
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const invoiceId = `LIBER-${year}${month}${day}-${String(this.invoiceCounter).padStart(3, '0')}`;
        document.getElementById('invoiceId').value = invoiceId;
    }

    addServiceRow() {
        const servicesList = document.getElementById('servicesList');
        const serviceId = Date.now() + Math.random();
        
        const serviceRow = document.createElement('div');
        serviceRow.className = 'service-item';
        serviceRow.dataset.serviceId = serviceId;
        
        serviceRow.innerHTML = `
            <div class="service-item-header">
                <div class="service-item-title">Service ${this.currentServices.length + 1}</div>
                <button type="button" class="remove-service-btn" onclick="app.removeServiceRow('${serviceId}')">
                    <i class="fas fa-trash"></i> Remove
                </button>
            </div>
            <div class="service-fields">
                <div class="form-group">
                    <label>Service Name</label>
                    <div class="input-with-dropdown">
                        <input type="text" class="service-name" placeholder="Enter service name or select from saved" required>
                        <button type="button" class="dropdown-btn service-dropdown-btn">
                            <i class="fas fa-chevron-down"></i>
                        </button>
                        <div class="dropdown-menu service-dropdown">
                            ${this.services.map(service => `
                                <div class="dropdown-item" data-service='${JSON.stringify(service)}'>
                                    <div>${service.name}</div>
                                    <small>$${service.cost}${service.rate ? ` / $${service.rate}/hr` : ''}</small>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                </div>
                <div class="form-group">
                    <label>Cost</label>
                    <input type="number" class="service-cost" placeholder="0.00" step="0.01" min="0" required>
                </div>
                                 <div class="form-group">
                     <label>Unit (optional)</label>
                     <input type="text" class="service-unit" placeholder="e.g., hours, sf, count">
                 </div>
            </div>
        `;

        servicesList.appendChild(serviceRow);
        this.currentServices.push(serviceId);

        // Bind service dropdown events
        const dropdownBtn = serviceRow.querySelector('.service-dropdown-btn');
        const dropdown = serviceRow.querySelector('.service-dropdown');
                 const nameInput = serviceRow.querySelector('.service-name');
         const costInput = serviceRow.querySelector('.service-cost');
         const unitInput = serviceRow.querySelector('.service-unit');

        dropdownBtn.addEventListener('click', () => {
            this.toggleServiceDropdown(dropdown);
        });

        dropdown.addEventListener('click', (e) => {
            if (e.target.closest('.dropdown-item')) {
                const serviceData = JSON.parse(e.target.closest('.dropdown-item').dataset.service);
                                 nameInput.value = serviceData.name;
                 costInput.value = serviceData.cost;
                 if (serviceData.rate) {
                     unitInput.value = '1 hour';
                 }
                this.toggleServiceDropdown(dropdown);
                this.calculateTotal();
            }
        });

                 // Bind input events for total calculation
         [costInput, unitInput].forEach(input => {
             input.addEventListener('input', () => this.calculateTotal());
         });

        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.input-with-dropdown')) {
                this.closeServiceDropdown(dropdown);
            }
        });
    }

    removeServiceRow(serviceId) {
        const serviceRow = document.querySelector(`[data-service-id="${serviceId}"]`);
        if (serviceRow) {
            serviceRow.remove();
            this.currentServices = this.currentServices.filter(id => id !== serviceId);
            this.calculateTotal();
        }
    }

    toggleServiceDropdown(dropdown) {
        dropdown.classList.toggle('show');
    }

    closeServiceDropdown(dropdown) {
        dropdown.classList.remove('show');
    }

    toggleClientDropdown() {
        const dropdown = document.getElementById('clientDropdown');
        dropdown.classList.toggle('show');
        
        if (dropdown.classList.contains('show')) {
            this.populateClientDropdown();
        }
    }

    closeClientDropdown() {
        document.getElementById('clientDropdown').classList.remove('show');
    }

    populateClientDropdown() {
        const dropdown = document.getElementById('clientDropdown');
        dropdown.innerHTML = this.clients.map(client => `
            <div class="dropdown-item" onclick="app.selectClient('${client.name}')">
                ${client.name}
            </div>
        `).join('');
    }

    selectClient(clientName) {
        document.getElementById('clientName').value = clientName;
        this.closeClientDropdown();
    }

    toggleProviderDropdown() {
        const dropdown = document.getElementById('providerDropdown');
        dropdown.classList.toggle('show');
        
        if (dropdown.classList.contains('show')) {
            this.populateProviderDropdown();
        }
    }

    closeProviderDropdown() {
        document.getElementById('providerDropdown').classList.remove('show');
    }

    populateProviderDropdown() {
        const dropdown = document.getElementById('providerDropdown');
        dropdown.innerHTML = this.providers.map(provider => `
            <div class="dropdown-item" onclick="app.selectProvider('${provider.name}')">
                ${provider.name}
            </div>
        `).join('');
    }

    selectProvider(providerName) {
        document.getElementById('providerName').value = providerName;
        this.closeProviderDropdown();
    }

              calculateTotal() {
         let total = 0;
         
         document.querySelectorAll('.service-item').forEach(serviceRow => {
             const cost = parseFloat(serviceRow.querySelector('.service-cost').value) || 0;
             const unitValue = serviceRow.querySelector('.service-unit').value.trim();
             
             // If unit is empty or N/A, use cost as is (1 unit)
             // If unit contains a number, extract it and multiply
             let multiplier = 1;
             if (unitValue && unitValue.toLowerCase() !== 'n/a') {
                 const numberMatch = unitValue.match(/(\d+(?:\.\d+)?)/);
                 if (numberMatch) {
                     multiplier = parseFloat(numberMatch[1]);
                 }
             }
             
             total += cost * multiplier;
         });

         document.getElementById('total').textContent = `$${total.toFixed(2)}`;
     }

    async saveService() {
        const name = document.getElementById('newServiceName').value.trim();
        const cost = parseFloat(document.getElementById('newServiceCost').value) || 0;
        const rate = parseFloat(document.getElementById('newServiceRate').value) || null;

        if (!name) {
            alert('Please enter a service name');
            return;
        }

        const service = { name, cost, rate };
        this.services.push(service);

        const success = await window.invoiceStore.saveService(window.firebaseService.auth.currentUser.uid, service);
        if (success) {
        // Clear form
        document.getElementById('newServiceName').value = '';
        document.getElementById('newServiceCost').value = '';
        document.getElementById('newServiceRate').value = '';

        this.loadSavedData();
        alert('Service saved successfully!');
        } else {
            alert('Failed to save service. Please try again.');
        }
    }

    async saveClient() {
        const name = document.getElementById('newClientName').value.trim();

        if (!name) {
            alert('Please enter a client name');
            return;
        }

        if (this.clients.some(client => client.name.toLowerCase() === name.toLowerCase())) {
            alert('Client already exists');
            return;
        }

        this.clients.push({ name });

        const success = await window.invoiceStore.saveClient(window.firebaseService.auth.currentUser.uid, { name });
        if (success) {
        // Clear form
        document.getElementById('newClientName').value = '';

        this.loadSavedData();
        alert('Client saved successfully!');
        } else {
            alert('Failed to save client. Please try again.');
        }
    }

    async saveProvider() {
        const name = document.getElementById('newProviderName').value.trim();

        if (!name) {
            alert('Please enter a provider name');
            return;
        }

        if (this.providers.some(provider => provider.name.toLowerCase() === name.toLowerCase())) {
            alert('Provider already exists');
            return;
        }

        this.providers.push({ name });

        const success = await window.invoiceStore.saveProvider(window.firebaseService.auth.currentUser.uid, { name });
        if (success) {
            // Clear form
            document.getElementById('newProviderName').value = '';

            this.loadSavedData();
            alert('Provider saved successfully!');
        } else {
            alert('Failed to save provider. Please try again.');
        }
    }

    loadSavedData() {
        // Load saved services
        const savedServicesList = document.getElementById('savedServicesList');
        savedServicesList.innerHTML = this.services.map((service, index) => `
            <div class="saved-item">
                <div class="saved-item-info">
                    <div class="saved-item-name">${service.name}</div>
                    <div class="saved-item-details">
                        Default Cost: $${service.cost}
                        ${service.rate ? ` | Rate: $${service.rate}/hr` : ''}
                    </div>
                </div>
                <button type="button" class="delete-btn" onclick="app.deleteService(${index})">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
        `).join('');

        // Load saved providers
        const savedProvidersList = document.getElementById('savedProvidersList');
        savedProvidersList.innerHTML = this.providers.map((provider, index) => `
            <div class="saved-item">
                <div class="saved-item-info">
                    <div class="saved-item-name">${provider.name}</div>
                </div>
                <button type="button" class="delete-btn" onclick="app.deleteProvider(${index})">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
        `).join('');

        // Load saved clients
        const savedClientsList = document.getElementById('savedClientsList');
        savedClientsList.innerHTML = this.clients.map((client, index) => `
            <div class="saved-item">
                <div class="saved-item-info">
                    <div class="saved-item-name">${client.name}</div>
                </div>
                <button type="button" class="delete-btn" onclick="app.deleteClient(${index})">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
        `).join('');
    }

    async deleteService(index) {
        if (confirm('Are you sure you want to delete this service?')) {
            const removed = this.services.splice(index, 1)[0];
            const success = await window.invoiceStore.deleteService(window.firebaseService.auth.currentUser.uid, removed);
            if (success) {
            this.loadSavedData();
            } else {
                alert('Failed to delete service. Please try again.');
            }
        }
    }

    async deleteClient(index) {
        if (confirm('Are you sure you want to delete this client?')) {
            const removed = this.clients.splice(index, 1)[0];
            const success = await window.invoiceStore.deleteClient(window.firebaseService.auth.currentUser.uid, removed);
            if (success) {
            this.loadSavedData();
            } else {
                alert('Failed to delete client. Please try again.');
            }
        }
    }

    async deleteProvider(index) {
        if (confirm('Are you sure you want to delete this provider?')) {
            const removed = this.providers.splice(index, 1)[0];
            const success = await window.invoiceStore.deleteProvider(window.firebaseService.auth.currentUser.uid, removed);
            if (success) {
                this.loadSavedData();
            } else {
                alert('Failed to delete provider. Please try again.');
            }
        }
    }

    validateInvoice() {
        const providerName = document.getElementById('providerName').value.trim();
        if (!providerName) {
            alert('Please enter a provider name');
            return false;
        }

        const clientName = document.getElementById('clientName').value.trim();
        if (!clientName) {
            alert('Please enter a client name');
            return false;
        }

        const services = document.querySelectorAll('.service-item');
        if (services.length === 0) {
            alert('Please add at least one service');
            return false;
        }

        for (let service of services) {
            const name = service.querySelector('.service-name').value.trim();
            const cost = service.querySelector('.service-cost').value;
            
            if (!name || !cost) {
                alert('Please fill in all service details');
                return false;
            }
        }

        return true;
    }

    getInvoiceData() {
        const providerName = document.getElementById('providerName').value.trim();
        const clientName = document.getElementById('clientName').value.trim();
        const invoiceDate = document.getElementById('invoiceDate').value;
        const invoiceId = document.getElementById('invoiceId').value;
        
                 const services = [];
         document.querySelectorAll('.service-item').forEach(serviceRow => {
             const name = serviceRow.querySelector('.service-name').value.trim();
             const cost = parseFloat(serviceRow.querySelector('.service-cost').value) || 0;
             const unitValue = serviceRow.querySelector('.service-unit').value.trim();
             
             // If unit is empty, set as N/A
             const unit = unitValue || 'N/A';
             
             // Calculate total based on unit
             let multiplier = 1;
             if (unitValue && unitValue.toLowerCase() !== 'n/a') {
                 const numberMatch = unitValue.match(/(\d+(?:\.\d+)?)/);
                 if (numberMatch) {
                     multiplier = parseFloat(numberMatch[1]);
                 }
             }
             const total = cost * multiplier;
             
             services.push({ name, cost, unit, total });
         });

                          const total = services.reduce((sum, service) => sum + service.total, 0);

         return {
             providerName,
             clientName,
             invoiceDate,
             invoiceId,
             services,
            total,
            createdAt: new Date().toISOString()
         };
    }

    showPreview() {
        if (!this.validateInvoice()) return;

        const data = this.getInvoiceData();
        const previewContent = document.getElementById('previewContent');
        
        previewContent.innerHTML = this.generateInvoiceHTML(data);
        
        const modal = document.getElementById('previewModal');
        modal.classList.add('show');
    }

    closePreview() {
        document.getElementById('previewModal').classList.remove('show');
    }

         generateInvoiceHTML(data) {
         // Fix timezone issue by creating date in local timezone
         const [year, month, day] = data.invoiceDate.split('-');
         const localDate = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
         const formattedDate = localDate.toLocaleDateString('en-US', {
             year: 'numeric',
             month: 'long',
             day: 'numeric'
         });

        return `
            <div class="invoice-preview">
                <div class="invoice-header">
                    <div class="invoice-logo">
                        <img src="images/logo.png" alt="LIBER" class="invoice-logo-image">
                    </div>
                    <div class="invoice-details">
                        <h2>INVOICE</h2>
                    </div>
                </div>
                
                <div class="invoice-info">
                    <table>
                        <tr>
                            <td>Provider:</td>
                            <td>${data.providerName}</td>
                        </tr>
                        <tr>
                            <td>Client:</td>
                            <td>${data.clientName}</td>
                        </tr>
                        <tr>
                            <td>Invoice ID:</td>
                            <td>${data.invoiceId}</td>
                        </tr>
                        <tr>
                            <td>Date:</td>
                            <td>${formattedDate}</td>
                        </tr>
                    </table>
                </div>
                
                <table class="services-table">
                                         <thead>
                         <tr>
                             <th>Service</th>
                             <th>Cost</th>
                             <th>Unit</th>
                             <th class="amount">Total</th>
                         </tr>
                     </thead>
                    <tbody>
                                                 ${data.services.map(service => `
                             <tr>
                                 <td>${service.name}</td>
                                 <td>$${service.cost.toFixed(2)}</td>
                                 <td>${service.unit}</td>
                                 <td class="amount">$${service.total.toFixed(2)}</td>
                             </tr>
                         `).join('')}
                    </tbody>
                </table>
                
                                 <div style="text-align: right; margin-bottom: 30px;">
                     <div style="font-size: 1.2em; font-weight: bold;">
                         <strong>Total: $${data.total.toFixed(2)}</strong>
                     </div>
                 </div>
                
                <div class="invoice-footer">
                    <p>LIBER CREATIVE LLC © 2025</p>
                </div>
            </div>
        `;
    }

    async generatePDF() {
        if (!this.validateInvoice()) return;

        const data = this.getInvoiceData();
        
        // Create PDF using jsPDF
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF();
        
        // Set font
        doc.setFont('helvetica');
        
        // Add logo (simulated with text)
        doc.setFontSize(24);
        doc.setFont('helvetica', 'bold');
        doc.text('LIBER', 20, 30);
        
        // Invoice title
        doc.setFontSize(20);
        doc.text('INVOICE', 150, 30);
        
        // Invoice details
        doc.setFontSize(12);
        doc.setFont('helvetica', 'normal');
        doc.text('Provider:', 20, 60);
        doc.text(data.providerName, 50, 60);
        
        doc.text('Client:', 20, 70);
        doc.text(data.clientName, 50, 70);
        
        doc.text('Invoice ID:', 20, 80);
        doc.text(data.invoiceId, 50, 80);
        
                 // Fix timezone issue by creating date in local timezone
         const [year, month, day] = data.invoiceDate.split('-');
         const localDate = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
         const formattedDate = localDate.toLocaleDateString('en-US', {
             year: 'numeric',
             month: 'long',
             day: 'numeric'
         });
         doc.text('Date:', 20, 90);
         doc.text(formattedDate, 50, 90);
        
                 // Services table
         const tableData = data.services.map(service => [
             service.name,
             `$${service.cost.toFixed(2)}`,
             service.unit,
             `$${service.total.toFixed(2)}`
         ]);
         
         doc.autoTable({
             startY: 110,
             head: [['Service', 'Cost', 'Unit', 'Total']],
            body: tableData,
            theme: 'grid',
            headStyles: { fillColor: [0, 0, 0] },
            styles: { fontSize: 10 }
        });
        
                 // Total
         const finalY = doc.lastAutoTable.finalY + 10;
         doc.setFont('helvetica', 'bold');
         doc.text('Total:', 150, finalY);
         doc.text(`$${data.total.toFixed(2)}`, 180, finalY);
        
                 // Footer
         doc.setFont('helvetica', 'normal');
         doc.setFontSize(10);
         doc.text('LIBER CREATIVE LLC © 2025', 105, finalY + 20, { align: 'center' });
        
        // Save invoice to Firestore and upload PDF (best-effort)
        const uid = window.firebaseService.auth.currentUser.uid;
        const ok = await window.invoiceStore.saveInvoice(uid, data, async (fileName) => {
            try { const pdfBlob = doc.output('blob'); await window.invoiceStore.uploadInvoicePdf(uid, fileName, pdfBlob); } catch(_) {}
        });
        if (!ok) { alert('Failed to save invoice. Please try again.'); return; }

        // Offer download to user too
        const filename = `invoice_${data.invoiceId}.pdf`;
        doc.save(filename);

        // Refresh state from store
        this.invoices = await window.invoiceStore.getInvoices(uid);
        this.invoiceCounter = await window.invoiceStore.getNextCounterPreview(uid);
        await this.generateInvoiceId();
        this.loadIssuedInvoices();
        
        alert('PDF generated and saved securely!');
    }

    loadIssuedInvoices() {
        const invoicesList = document.getElementById('invoicesList');
        
        if (this.invoices.length === 0) {
            invoicesList.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-file-invoice"></i>
                    <h3>No Invoices Found</h3>
                    <p>Generate your first invoice to see it here.</p>
                </div>
            `;
            return;
        }

        // Sort invoices by creation date (newest first)
        const sortedInvoices = [...this.invoices].sort((a, b) => 
            new Date(b.createdAt) - new Date(a.createdAt)
        );

        invoicesList.innerHTML = sortedInvoices.map(invoice => {
            const [year, month, day] = invoice.invoiceDate.split('-');
            const localDate = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
            const formattedDate = localDate.toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'short',
                day: 'numeric'
            });

            return `
                <div class="invoice-card" data-invoice-id="${invoice.invoiceId}">
                    <div class="invoice-card-header">
                        <div class="invoice-card-id">${invoice.invoiceId}</div>
                        <div class="invoice-card-date">${formattedDate}</div>
                    </div>
                    <div class="invoice-card-body">
                        <div class="invoice-card-provider">${invoice.providerName || 'N/A'}</div>
                        <div class="invoice-card-client">${invoice.clientName}</div>
                        <div class="invoice-card-total">$${invoice.total.toFixed(2)}</div>
                    </div>
                    <div class="invoice-card-actions">
                        <button type="button" class="btn btn-sm btn-secondary" onclick="app.viewInvoice('${invoice.invoiceId}')">
                            <i class="fas fa-eye"></i> View
                        </button>
                        <button type="button" class="btn btn-sm btn-danger" onclick="app.deleteInvoice('${invoice.invoiceId}')">
                            <i class="fas fa-trash"></i> Delete
                        </button>
                    </div>
                </div>
            `;
        }).join('');
    }

    filterInvoices() {
        const searchTerm = document.getElementById('invoiceSearch').value.toLowerCase();
        const dateFilter = document.getElementById('dateFilter').value;
        
        const filteredInvoices = this.invoices.filter(invoice => {
            // Search filter
            const matchesSearch = (invoice.providerName && invoice.providerName.toLowerCase().includes(searchTerm)) ||
                                invoice.clientName.toLowerCase().includes(searchTerm) ||
                                invoice.invoiceId.toLowerCase().includes(searchTerm);
            
            if (!matchesSearch) return false;
            
            // Date filter
            if (dateFilter === 'all') return true;
            
            const invoiceDate = new Date(invoice.invoiceDate);
            const today = new Date();
            const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
            
            switch (dateFilter) {
                case 'today':
                    return invoiceDate >= startOfDay;
                case 'week':
                    const weekAgo = new Date(startOfDay.getTime() - 7 * 24 * 60 * 60 * 1000);
                    return invoiceDate >= weekAgo;
                case 'month':
                    const monthAgo = new Date(today.getFullYear(), today.getMonth(), 1);
                    return invoiceDate >= monthAgo;
                case 'year':
                    const yearAgo = new Date(today.getFullYear(), 0, 1);
                    return invoiceDate >= yearAgo;
                default:
                    return true;
            }
        });

        this.displayFilteredInvoices(filteredInvoices);
    }

    displayFilteredInvoices(filteredInvoices) {
        const invoicesList = document.getElementById('invoicesList');
        
        if (filteredInvoices.length === 0) {
            invoicesList.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-search"></i>
                    <h3>No Invoices Found</h3>
                    <p>Try adjusting your search criteria or date filter.</p>
                </div>
            `;
            return;
        }

        // Sort filtered invoices by creation date (newest first)
        const sortedInvoices = [...filteredInvoices].sort((a, b) => 
            new Date(b.createdAt) - new Date(a.createdAt)
        );

        invoicesList.innerHTML = sortedInvoices.map(invoice => {
            const [year, month, day] = invoice.invoiceDate.split('-');
            const localDate = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
            const formattedDate = localDate.toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'short',
                day: 'numeric'
            });

            return `
                <div class="invoice-card" data-invoice-id="${invoice.invoiceId}">
                    <div class="invoice-card-header">
                        <div class="invoice-card-id">${invoice.invoiceId}</div>
                        <div class="invoice-card-date">${formattedDate}</div>
                    </div>
                    <div class="invoice-card-body">
                        <div class="invoice-card-client">${invoice.clientName}</div>
                        <div class="invoice-card-total">$${invoice.total.toFixed(2)}</div>
                    </div>
                    <div class="invoice-card-actions">
                        <button type="button" class="btn btn-sm btn-secondary" onclick="app.viewInvoice('${invoice.invoiceId}')">
                            <i class="fas fa-eye"></i> View
                        </button>
                        <button type="button" class="btn btn-sm btn-danger" onclick="app.deleteInvoice('${invoice.invoiceId}')">
                            <i class="fas fa-trash"></i> Delete
                        </button>
                    </div>
                </div>
            `;
        }).join('');
    }

    viewInvoice(invoiceId) {
        const invoice = this.invoices.find(inv => inv.invoiceId === invoiceId);
        if (!invoice) {
            alert('Invoice not found');
            return;
        }

        this.currentInvoiceId = invoiceId;
        const detailsContent = document.getElementById('invoiceDetailsContent');
        detailsContent.innerHTML = this.generateInvoiceHTML(invoice);
        
        const modal = document.getElementById('invoiceDetailsModal');
        modal.classList.add('show');
    }

    closeInvoiceDetails() {
        document.getElementById('invoiceDetailsModal').classList.remove('show');
        this.currentInvoiceId = null;
    }

    downloadInvoice() {
        if (!this.currentInvoiceId) return;
        
        const invoice = this.invoices.find(inv => inv.invoiceId === this.currentInvoiceId);
        if (!invoice) {
            alert('Invoice not found');
            return;
        }

        // Create PDF using jsPDF
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF();
        
        // Set font
        doc.setFont('helvetica');
        
        // Add logo (simulated with text)
        doc.setFontSize(24);
        doc.setFont('helvetica', 'bold');
        doc.text('LIBER', 20, 30);
        
        // Invoice title
        doc.setFontSize(20);
        doc.text('INVOICE', 150, 30);
        
        // Invoice details
        doc.setFontSize(12);
        doc.setFont('helvetica', 'normal');
        doc.text('Provider:', 20, 60);
        doc.text(invoice.providerName || 'N/A', 50, 60);
        
        doc.text('Client:', 20, 70);
        doc.text(invoice.clientName, 50, 70);
        
        doc.text('Invoice ID:', 20, 80);
        doc.text(invoice.invoiceId, 50, 80);
        
        // Fix timezone issue by creating date in local timezone
        const [year, month, day] = invoice.invoiceDate.split('-');
        const localDate = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
        const formattedDate = localDate.toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });
        doc.text('Date:', 20, 90);
        doc.text(formattedDate, 50, 90);
        
        // Services table
        const tableData = invoice.services.map(service => [
            service.name,
            `$${service.cost.toFixed(2)}`,
            service.unit,
            `$${service.total.toFixed(2)}`
        ]);
        
        doc.autoTable({
            startY: 110,
            head: [['Service', 'Cost', 'Unit', 'Total']],
            body: tableData,
            theme: 'grid',
            headStyles: { fillColor: [0, 0, 0] },
            styles: { fontSize: 10 }
        });
        
        // Total
        const finalY = doc.lastAutoTable.finalY + 10;
        doc.setFont('helvetica', 'bold');
        doc.text('Total:', 150, finalY);
        doc.text(`$${invoice.total.toFixed(2)}`, 180, finalY);
        
        // Footer
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10);
        doc.text('LIBER CREATIVE LLC © 2025', 105, finalY + 20, { align: 'center' });
        
        // Issued by line
        const currentUser = (window.firebaseService && window.firebaseService.auth && (window.firebaseService.auth.currentUser.email || window.firebaseService.auth.currentUser.uid)) || 'Unknown User';
        doc.setFontSize(8);
        doc.text(`Issued by: ${currentUser}`, 180, finalY + 15, { align: 'right' });
        
        // Save PDF
        const filename = `invoice_${invoice.invoiceId}.pdf`;
        doc.save(filename);
    }

    async deleteInvoice(invoiceId) {
        if (!confirm('Are you sure you want to delete this invoice? This action cannot be undone.')) {
            return;
        }

        const uid = window.firebaseService.auth.currentUser.uid;
        const success = await window.invoiceStore.deleteInvoice(uid, invoiceId);
        if (success) {
            // Update local data
            this.invoices = this.invoices.filter(inv => inv.invoiceId !== invoiceId);
            
            // Reload the invoices list
            this.loadIssuedInvoices();
            
            // Close modal if it's open
            if (this.currentInvoiceId === invoiceId) {
                this.closeInvoiceDetails();
            }
            
            alert('Invoice deleted successfully!');
        } else {
            alert('Failed to delete invoice. Please try again.');
        }
    }

    async deleteCurrentInvoice() {
        if (this.currentInvoiceId) {
            await this.deleteInvoice(this.currentInvoiceId);
        }
    }

    // Back to Control Panel function
    goBack() {
        if (window.opener) {
            window.close();
        } else {
            window.history.back();
        }
    }
}

// Initialize the application when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.app = new InvoiceGenerator();
});

// Global goBack function for the back button
function goBack() {
    if (window.opener) {
        window.close();
    } else {
        window.history.back();
    }
}
