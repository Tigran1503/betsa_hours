import cookie from 'cookie';

export default function handler(req, res) {
    if (req.method !== 'POST')
        return res.status(405).end('Method Not Allowed');

    const { access_token } = req.body || {};
    if (!access_token)
        return res.status(400).send('missing token');

    res.setHeader(
        'Set-Cookie',
        cookie.serialize('sb-access-token', access_token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge: 60 * 60,  // 1 h  (Sekunden!)
            path: '/',
        }),
    );
    res.status(200).end();
}