import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm'

/* Supabase-Konfiguration */
const SUPABASE_URL = 'https://miocwppzogkspjljrtdd.supabase.co'
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1pb2N3cHB6b2drc3BqbGpydGRkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDY5NjQ4MzMsImV4cCI6MjA2MjU0MDgzM30.Zor-x14LXoM7jp3OOVO3xwfqnjELb145CLfFACLMBTM'

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

document
  .querySelector('#login-form')
  .addEventListener('submit', async (e) => {
    e.preventDefault()

    const email    = document.querySelector('#email').value.trim()
    const password = document.querySelector('#password').value.trim()

    /* 1. Supabase-Login */
    const { data, error } =
      await supabase.auth.signInWithPassword({ email, password })

    if (error) {
      alert(error.message)
      return
    }

    /* 2. Session-JWT beim Backend als HttpOnly-Cookie ablegen */
    const resp = await fetch('/auth/set', {   //  ← /api/…
      method      : 'POST',
      headers     : { 'Content-Type': 'application/json' },
      credentials : 'include',                    // kann gleich bleiben
      body        : JSON.stringify({ access_token: data.session.access_token })
    })

    if (!resp.ok) {
      alert('Konnte Session-Cookie nicht setzen')
      return
    }

    /* 3. Weiter auf die „Wahlseite“ */
    window.location = '/index.html'
  })