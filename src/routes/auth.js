import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { pool } from '../db.js';
import { asyncRoute, HttpError } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { allow, signStaffToken, ALL_STAFF } from '../middleware/auth.js';

export const authRouter = Router();

// 10 login attempts per 15 minutes per IP
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });

authRouter.post(
  '/login',
  loginLimiter,
  asyncRoute(async (req, res) => {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const password = String(req.body?.password ?? '');
    if (!email || !password) throw new HttpError(400, 'Email and password are required');

    const { rows } = await pool.query(
      'SELECT id, full_name, email, role, site_id, password_hash, active FROM staff_users WHERE email = $1',
      [email],
    );
    const user = rows[0];
    const ok = user && user.active && (await bcrypt.compare(password, user.password_hash));
    if (!ok) {
      await audit(pool, req, { action: 'LOGIN_FAILED', entity: 'staff_users', details: { email } });
      throw new HttpError(401, 'Wrong email or password');
    }
    req.staff = user;
    await audit(pool, req, { action: 'LOGIN', entity: 'staff_users', entityId: user.id });
    res.json({
      token: signStaffToken(user),
      user: { id: user.id, fullName: user.full_name, email: user.email, role: user.role, siteId: user.site_id },
    });
  }),
);

authRouter.get(
  '/me',
  allow({ staff: ALL_STAFF }),
  (req, res) => {
    const u = req.staff;
    res.json({ id: u.id, fullName: u.full_name, email: u.email, role: u.role, siteId: u.site_id });
  },
);
