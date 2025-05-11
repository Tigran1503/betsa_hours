export default function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();
  
    const { access_token } = req.body || {};
    if (!access_token) return res.status(400).send('missing token');
  
    res.setHeader('Set-Cookie', [
      `sb-access-token=${access_token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600;` +
      (process.env.NODE_ENV === 'production' ? ' Secure;' : '')
    ]);
  
    res.status(200).end();
  }