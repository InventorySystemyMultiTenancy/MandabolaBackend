import express from "express";
import {
  executarAcaoMandaAi,
  processarComandoMandaAi,
  statusMandaAi,
} from "../controllers/mandaAiController.js";
import { autenticar, registrarLog } from "../middlewares/auth.js";

const router = express.Router();

// GET /api/mandaai/status - nome, modo (ia/basico) e sugestões
router.get("/status", autenticar, statusMandaAi);

// POST /api/mandaai/comando - { texto, historico: [{autor, texto}] }
router.post(
  "/comando",
  autenticar,
  registrarLog("COMANDO_MANDAAI", "MandaAI"),
  processarComandoMandaAi,
);

// POST /api/mandaai/executar - ação confirmada pelo usuário
router.post(
  "/executar",
  autenticar,
  registrarLog("ACAO_MANDAAI", "MandaAI"),
  executarAcaoMandaAi,
);

export default router;
