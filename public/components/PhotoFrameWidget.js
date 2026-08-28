class PhotoFrameWidget extends HTMLElement {
  connectedCallback() { this.classList.add("block", "w-full", "h-full");
    this.images = [];
    this.currentIndex = 0;
    this.intervalId = null;
    this.render();
    this.loadImages();
  }

  disconnectedCallback() { this.classList.add("block", "w-full", "h-full");
    if (this.intervalId) clearInterval(this.intervalId);
  }

  static get observedAttributes() { return ['library', 'interval']; }
  
  attributeChangedCallback(name, oldVal, newVal) {
    if (oldVal !== newVal) {
      if (name === 'library') this.loadImages();
      if (name === 'interval') this.startRotation();
    }
  }

  async loadImages() {
    const library = this.getAttribute('library') || 'default';
    try {
      const res = await fetch(`/api/media/files?library=${library}`);
      const files = await res.json();
      if (!files.error && files.length > 0) {
        this.images = files.map(f => f.path);
        this.currentIndex = 0;
        this.updateImage();
        this.startRotation();
      } else {
        this.images = [];
        this.innerHTML = `<div class="bg-dark-card rounded-xl p-4 flex items-center justify-center h-full border border-dark-border min-h-[12rem] text-gray-500 text-xs text-center"><i class="fa-solid fa-image mr-2"></i> No photos in ${library}</div>`;
      }
    } catch (err) {
      console.error('PhotoFrame failed to load', err);
    }
  }

  startRotation() {
    if (this.intervalId) clearInterval(this.intervalId);
    if (this.images.length <= 1) return;
    const intervalSecs = parseInt(this.getAttribute('interval') || '10', 10);
    this.intervalId = setInterval(() => {
      this.currentIndex = (this.currentIndex + 1) % this.images.length;
      this.updateImage();
    }, intervalSecs * 1000);
  }

  updateImage() {
    if (this.images.length === 0) return;
    const imgEl = this.querySelector('img');
    if (imgEl) {
      imgEl.style.opacity = 0;
      setTimeout(() => {
        imgEl.src = this.images[this.currentIndex];
        imgEl.style.opacity = 1;
      }, 300); // fade out/in effect
    } else {
      this.render(); // initial render
    }
  }

  render() {
    if (this.images.length === 0) {
      this.innerHTML = `<div class="bg-dark-card rounded-xl p-4 flex items-center justify-center h-full min-h-[12rem] border border-dark-border text-gray-500 text-xs text-center"><i class="fa-solid fa-spinner fa-spin mr-2"></i> Loading Photos...</div>`;
      return;
    }
    
    this.innerHTML = `
      <div class="relative rounded-xl overflow-hidden shadow-lg h-full min-h-[12rem] group border border-dark-border bg-dark-bg">
        <img src="${this.images[this.currentIndex]}" class="w-full h-full object-cover transition-opacity duration-300" style="opacity: 1;" loading="lazy">
        <div class="absolute inset-0 shadow-[inset_0_0_20px_rgba(0,0,0,0.5)] pointer-events-none"></div>
        <div class="absolute top-2 right-2 bg-black/50 backdrop-blur-md rounded px-2 py-1 text-[9px] text-gray-300 opacity-0 group-hover:opacity-100 transition-opacity">
          <i class="fa-solid fa-folder-open mr-1 text-indigo-400"></i> ${this.getAttribute('library') || 'default'}
        </div>
      </div>
    `;
  }
}
customElements.define('ada-photo-frame', PhotoFrameWidget);
