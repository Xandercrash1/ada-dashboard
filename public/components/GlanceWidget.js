/**
 * GlanceWidget.js - <ada-glance> Web Component
 * 
 * Displays an intelligent "At a glance" message at the top of the Ada Dashboard.
 * Polls GET /api/glance every 10 seconds.
 * Fallback: Time-of-day greeting (e.g. "🌤️ Good afternoon, Alex. All systems nominal.")
 */

class AdaGlance extends HTMLElement {
  constructor() {
    super();
    this._pollInterval = null;
    this._fallbackText = this._getGreeting();
  }

  connectedCallback() {
    this.render();
    this.fetchGlance();
    this._pollInterval = setInterval(() => this.fetchGlance(), 10000);
  }

  disconnectedCallback() {
    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
  }

  static get observedAttributes() { return ['theme', 'accent']; }
  attributeChangedCallback() { this.render(); this.fetchGlance(); }

  _getGreeting() {
    const hour = new Date().getHours();
    let timeGreeting = 'afternoon';
    let icon = '🌤️';

    if (hour >= 5 && hour < 12) {
      timeGreeting = 'morning';
      icon = '🌅';
    } else if (hour >= 12 && hour < 17) {
      timeGreeting = 'afternoon';
      icon = '🌤️';
    } else if (hour >= 17 && hour < 22) {
      timeGreeting = 'evening';
      icon = '🌆';
    } else {
      timeGreeting = 'night';
      icon = '🌙';
    }

    return `${icon} Good ${timeGreeting}, Alex. All systems nominal.`;
  }

  async fetchGlance() {
    try {
      const response = await fetch('/api/glance');
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = await response.json();
      this._updateContent({
        text: data.text || this._getGreeting(),
        icon: data.icon || 'fa-solid fa-sparkles',
        color: data.color || 'indigo'
      });
    } catch (err) {
      // Fallback on network/API failure
      this._updateContent({
        text: this._getGreeting(),
        icon: 'fa-solid fa-cloud-sun',
        color: 'indigo'
      });
    }
  }

  _getColorClasses(colorName) {
    const map = {
      indigo: {
        bg: 'bg-indigo-500/10 dark:bg-indigo-500/20',
        text: 'text-indigo-400 dark:text-indigo-300',
        border: 'border-indigo-500/20'
      },
      emerald: {
        bg: 'bg-emerald-500/10 dark:bg-emerald-500/20',
        text: 'text-emerald-400 dark:text-emerald-300',
        border: 'border-emerald-500/20'
      },
      green: {
        bg: 'bg-green-500/10 dark:bg-green-500/20',
        text: 'text-green-400 dark:text-green-300',
        border: 'border-green-500/20'
      },
      amber: {
        bg: 'bg-amber-500/10 dark:bg-amber-500/20',
        text: 'text-amber-400 dark:text-amber-300',
        border: 'border-amber-500/20'
      },
      rose: {
        bg: 'bg-rose-500/10 dark:bg-rose-500/20',
        text: 'text-rose-400 dark:text-rose-300',
        border: 'border-rose-500/20'
      },
      sky: {
        bg: 'bg-sky-500/10 dark:bg-sky-500/20',
        text: 'text-sky-400 dark:text-sky-300',
        border: 'border-sky-500/20'
      },
      purple: {
        bg: 'bg-purple-500/10 dark:bg-purple-500/20',
        text: 'text-purple-400 dark:text-purple-300',
        border: 'border-purple-500/20'
      }
    };
    return map[colorName] || map.indigo;
  }

  _updateContent({ text, icon, color }) {
    const textEl = this.querySelector('[data-glance-text]');
    const iconWrapper = this.querySelector('[data-glance-icon-wrapper]');
    const iconEl = this.querySelector('[data-glance-icon]');

    if (textEl) {
      textEl.textContent = text;
    }

    if (iconWrapper && iconEl) {
      const colors = this._getColorClasses(color);
      iconWrapper.className = `flex-shrink-0 w-8 h-8 rounded-lg ${colors.bg} ${colors.text} flex items-center justify-center transition-colors duration-300`;
      
      // Handle fontawesome class string or emoji
      if (icon && (icon.includes('fa-') || icon.startsWith('fa '))) {
        iconEl.className = icon.startsWith('fa') ? icon : `fa-solid ${icon}`;
        iconEl.style.display = 'inline-block';
      } else if (icon) {
        iconEl.className = '';
        iconEl.textContent = icon;
      }
    }
  }

  render() {
    const greeting = this._getGreeting();
    const colors = this._getColorClasses('indigo');

    const theme = this.getAttribute('theme') || 'glass';
    const accent = this.getAttribute('accent') || 'indigo';
    let bgClass = 'bg-white/5 backdrop-blur-md border border-white/10 dark:border-white/5 shadow-sm';
    
    if (theme === 'neon') bgClass = `bg-${accent}-500/10 backdrop-blur-md border border-${accent}-500/50 shadow-[0_0_15px_rgba(0,0,0,0)] shadow-${accent}-500/30 text-${accent}-100`;
    else if (theme === 'gradient') bgClass = `bg-gradient-to-br from-${accent}-600/80 to-${accent}-900/80 backdrop-blur-md border border-${accent}-400/30 shadow-lg text-white`;
    else if (theme === 'transparent') bgClass = '';

    this.innerHTML = `
      <div class="${bgClass} rounded-xl p-4 flex items-center gap-3 transition-all duration-300">
        <div data-glance-icon-wrapper class="flex-shrink-0 w-8 h-8 rounded-lg ${colors.bg} ${colors.text} flex items-center justify-center transition-colors duration-300">
          <i data-glance-icon class="fa-solid fa-cloud-sun"></i>
        </div>
        <div class="flex-1 font-medium text-sm text-gray-200 dark:text-gray-200" data-glance-text>
          ${greeting}
        </div>
      </div>
    `;
  }
}

customElements.define('ada-glance', AdaGlance);
export default AdaGlance;
