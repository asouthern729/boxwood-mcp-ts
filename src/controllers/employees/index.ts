import asyncHandler from "../../middleware/async/index.js"
import { Employee } from "../../models/index.js"

// Types
import { Request, Response, NextFunction } from "express"
import { Model } from "sequelize"
import { EmployeeInterface } from "../../models/types.js"
import { ErrorResponse } from "../../utils/errorResponse.js"

export const getEmployees = asyncHandler(async(_req: Request, res: Response<{ data: Model<EmployeeInterface>[] }>, _next: NextFunction) => {
  const employees = await Employee.findAll() as Model<EmployeeInterface>[]

  res.status(200).json({
    data: employees
  })
})

export const getEmployee = asyncHandler(async(req: Request<{ empid: string }>, res: Response<{ data: Model<EmployeeInterface> }>, next: NextFunction) => {
  const employee = await Employee.findOne({
    where: {
      empid: req.params.empid
    }
  }) as Model<EmployeeInterface>

  if(!employee) {
    return next(new ErrorResponse(`Unable to return employee by empid ${ req.params.empid }`, 404),)
  }

  res.status(200).json({
    data: employee
  })
})