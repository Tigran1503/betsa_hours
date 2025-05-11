// public/js/logout.js
window.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('logout-btn')
    if (!btn) return
  
    btn.addEventListener('click', async () => {
      await fetch('/auth/logout', { method: 'POST' })
      // nach Logout zur Loginseite
      window.location = '/login.html'
    })
  })