'use strict';

import { Model, Sequelize, DataTypes } from "sequelize"
import type { EmployeeInterface } from "./types.js"

export default (sequelize: Sequelize, dataTypes: typeof DataTypes) => {
  class Employee extends Model<EmployeeInterface>{
    declare empcode: string
    declare empid: string
    declare isrep: string
    declare isprod: string
    declare istelemarketer: string
    declare isother: string
    declare lastname: string
    declare firstname: string | null
    declare middlename: string | null
    declare shortname: string | null
    declare address1: string | null
    declare address2: string | null
    declare city: string | null
    declare state: string | null
    declare isforeign: string
    declare countrycode: string | null
    declare zip: string | null
    declare busareacode: string | null
    declare busphone: string | null
    declare busext: string | null
    declare homeareacode: string | null
    declare homephone: string | null
    declare homeext: string | null
    declare faxareacode: string | null
    declare faxphone: string | null
    declare faxext: string | null
    declare dob: Date | null
    declare fullparttimeind: string | null
    declare title: string | null
    declare empsupervisorcode: string | null
    declare status: string | null
    declare islicensed: string | null
    declare mobileareacode: string | null
    declare mobilephone: string | null
    declare mobileext: string | null
    declare pagerareacode: string | null
    declare pagerphone: string | null
    declare pagerext: string | null
    declare ismemocommissions: string | null
    declare yearemployed: string | null
    declare emergencycontact: string | null
    declare contactareacode: string | null
    declare contactphone: string | null
    declare contactext: string | null
    declare imageid: string | null
    declare imagetype: number | null
    declare logsuspense: string | null
    declare email: string | null
    declare s1099category: number | null
    declare s1099type: number | null
    declare tzcode: number
    declare natlprodcode: string | null
    declare bjeclosedstatus: string
    declare islimitcustaccess: string
    declare doc360hotfolderloc: string | null
    declare doc360hotspot: string
    declare employeeid: string | null
    declare homefullphone: string | null
    declare busfullphone: string | null
    declare faxfullphone: string | null
    declare mobilefullphone: string | null
    declare pagerfullphone: string | null
    declare contactfullphone: string | null
    declare buacsid: string | null
    declare limitamount: string | null
    declare changedby: string
    declare changeddate: Date
    declare entereddate: Date
    declare defaultgldivcode: string | null
    declare defaultglbrnchcode: string | null
    declare defaultgldeptcode: string | null
    declare defaultglgrpcode: string | null
    declare isdefaultbuforcustomer: string | null
    declare isdefaultbuforpolicy: string | null

    static associate(){}
  }

  Employee.init({
    empcode: {
      type: dataTypes.STRING,
      primaryKey: true,
      allowNull: false
    },
    empid: {
      type: dataTypes.UUID,
      allowNull: false
    },
    isrep: {
      type: dataTypes.CHAR(1),
      allowNull: false
    },
    isprod: {
      type: dataTypes.CHAR(1),
      allowNull: false
    },
    istelemarketer: {
      type: dataTypes.CHAR(1),
      allowNull: false
    },
    isother: {
      type: dataTypes.CHAR(1),
      allowNull: false
    },
    lastname: {
      type: dataTypes.TEXT,
      allowNull: false
    },
    firstname: {
      type: dataTypes.TEXT
    },
    middlename: {
      type: dataTypes.TEXT
    },
    shortname: {
      type: dataTypes.TEXT
    },
    address1: {
      type: dataTypes.TEXT
    },
    address2: {
      type: dataTypes.TEXT
    },
    city: {
      type: dataTypes.TEXT
    },
    state: {
      type: dataTypes.CHAR(1)
    },
    isforeign: {
      type: dataTypes.CHAR(1),
      allowNull: false
    },
    countrycode: {
      type: dataTypes.TEXT
    },
    zip: {
      type: dataTypes.TEXT
    },
    busareacode: {
      type: dataTypes.TEXT
    },
    busphone: {
      type: dataTypes.TEXT
    },
    busext: {
      type: dataTypes.TEXT
    },
    homeareacode: {
      type: dataTypes.TEXT
    },
    homephone: {
      type: dataTypes.TEXT
    },
    homeext: {
      type: dataTypes.TEXT
    },
    faxareacode: {
      type: dataTypes.TEXT
    },
    faxphone: {
      type: dataTypes.TEXT
    },
    faxext: {
      type: dataTypes.TEXT
    },
    dob: {
      // Always null: excluded at the ETL's API request layer, never synced.
      type: dataTypes.DATE
    },
    fullparttimeind: {
      type: dataTypes.CHAR(1)
    },
    title: {
      type: dataTypes.TEXT
    },
    empsupervisorcode: {
      // Soft self-reference to another Employee's empcode; no DB-level FK constraint.
      type: dataTypes.STRING
    },
    status: {
      type: dataTypes.CHAR(1)
    },
    islicensed: {
      type: dataTypes.CHAR(1)
    },
    mobileareacode: {
      type: dataTypes.TEXT
    },
    mobilephone: {
      type: dataTypes.TEXT
    },
    mobileext: {
      type: dataTypes.TEXT
    },
    pagerareacode: {
      type: dataTypes.TEXT
    },
    pagerphone: {
      type: dataTypes.TEXT
    },
    pagerext: {
      type: dataTypes.TEXT
    },
    ismemocommissions: {
      type: dataTypes.CHAR(1)
    },
    yearemployed: {
      type: dataTypes.TEXT
    },
    emergencycontact: {
      type: dataTypes.TEXT
    },
    contactareacode: {
      type: dataTypes.TEXT
    },
    contactphone: {
      type: dataTypes.TEXT
    },
    contactext: {
      type: dataTypes.TEXT
    },
    imageid: {
      type: dataTypes.UUID
    },
    imagetype: {
      type: dataTypes.SMALLINT
    },
    logsuspense: {
      type: dataTypes.CHAR(1)
    },
    email: {
      type: dataTypes.TEXT
    },
    s1099category: {
      type: dataTypes.SMALLINT
    },
    s1099type: {
      type: dataTypes.SMALLINT
    },
    tzcode: {
      type: dataTypes.SMALLINT,
      allowNull: false
    },
    natlprodcode: {
      type: dataTypes.BIGINT
    },
    bjeclosedstatus: {
      type: dataTypes.CHAR(1),
      allowNull: false
    },
    islimitcustaccess: {
      type: dataTypes.CHAR(1),
      allowNull: false
    },
    doc360hotfolderloc: {
      type: dataTypes.TEXT
    },
    doc360hotspot: {
      type: dataTypes.CHAR(1),
      allowNull: false
    },
    employeeid: {
      type: dataTypes.STRING
    },
    homefullphone: {
      type: dataTypes.TEXT
    },
    busfullphone: {
      type: dataTypes.TEXT
    },
    faxfullphone: {
      type: dataTypes.TEXT
    },
    mobilefullphone: {
      type: dataTypes.TEXT
    },
    pagerfullphone: {
      type: dataTypes.TEXT
    },
    contactfullphone: {
      type: dataTypes.TEXT
    },
    buacsid: {
      // Soft reference to a business-unit table; no DB-level FK constraint.
      type: dataTypes.UUID
    },
    limitamount: {
      type: dataTypes.DECIMAL
    },
    changedby: {
      type: dataTypes.STRING,
      allowNull: false
    },
    changeddate: {
      type: dataTypes.DATE,
      allowNull: false
    },
    entereddate: {
      type: dataTypes.DATE,
      allowNull: false
    },
    defaultgldivcode: {
      type: dataTypes.TEXT
    },
    defaultglbrnchcode: {
      type: dataTypes.TEXT
    },
    defaultgldeptcode: {
      type: dataTypes.TEXT
    },
    defaultglgrpcode: {
      type: dataTypes.TEXT
    },
    isdefaultbuforcustomer: {
      type: dataTypes.TEXT
    },
    isdefaultbuforpolicy: {
      type: dataTypes.CHAR(1)
    }
  },{
    sequelize,
    freezeTableName: true,
    timestamps: false,
    modelName: 'Employee',
    tableName: 'afw_employee'
  })

  return Employee
}
