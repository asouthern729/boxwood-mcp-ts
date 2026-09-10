import { Router } from "express"
import { getEmployee, getEmployees } from "../controllers/employees/index.js"
import auth0 from "../middleware/auth/auth0/index.js"

export const router = Router()

router
  .route('/employees')
  .get(auth0, getEmployees)

router
  .route('/employees/:empid')
  .get(auth0, getEmployee)