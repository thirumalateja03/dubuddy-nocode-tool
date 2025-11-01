import { Router } from "express";
import { register, token, logout } from "../controllers/auth.controller";
import { authenticateMiddleware } from "../middleware/auth.middleware";
import { allowAdminOrFeature } from "../middleware/allowAdminOrFeature.middleware";


const router = Router();


// Create user: Admin OR CREATE_USER feature
router.post("/register", authenticateMiddleware, allowAdminOrFeature("CREATE_USER"), register);


// Login (returns access + refresh) or refresh tokens
router.post("/token", token);


// Logout: authenticated users can revoke their refresh token
router.post("/logout", authenticateMiddleware, logout);


export default router;