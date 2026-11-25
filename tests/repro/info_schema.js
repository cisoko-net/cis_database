'use strict';

// information_schema and SHOW, answered from SQLite. The DDL runs through the
// engine, then the queries resources send (esx migrations, ps-mdt, npwd).
// Every expected result is what MariaDB 10.11.14 returned for the same DDL and
// query. Not covered: ORDER BY on names with _ (SQLite NOCASE sorts _ before
// letters, MariaDB general_ci after), the CHECK constraint MariaDB adds for a
// JSON column, and the estimated CARDINALITY in SHOW INDEX.
// Usage: node tests/repro/info_schema.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DDL = [
    "CREATE TABLE `users` (`identifier` VARCHAR(46) NOT NULL, `accounts` LONGTEXT NULL DEFAULT NULL, `group` VARCHAR(50) NULL DEFAULT 'user', `job` VARCHAR(20) NULL DEFAULT 'unemployed', `job_grade` INT(11) NULL DEFAULT 0, `position` longtext NULL DEFAULT NULL, `firstname` VARCHAR(16) NULL DEFAULT NULL, `dateofbirth` VARCHAR(10) NULL DEFAULT NULL, `sex` VARCHAR(1) NULL DEFAULT NULL, `height` INT NULL DEFAULT NULL, `skin` LONGTEXT NULL DEFAULT NULL, `status` LONGTEXT NULL DEFAULT NULL, `is_dead` TINYINT(1) NULL DEFAULT 0, `id` int(11) NOT NULL AUTO_INCREMENT, `disabled` TINYINT(1) NULL DEFAULT 0, `last_seen` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, `money` DECIMAL(10,2) NOT NULL DEFAULT '0.00', `pincode` INT UNSIGNED NULL, `meta` JSON DEFAULT NULL, `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY (`identifier`), UNIQUE KEY `id` (`id`), KEY `idx_job` (`job`, `job_grade`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
    "CREATE TABLE IF NOT EXISTS `mdt_warrant_requests` (`id` INT AUTO_INCREMENT PRIMARY KEY, `status` ENUM('pending', 'approved','denied' ,'closed') NOT NULL DEFAULT 'pending', `notes` TEXT, `amount` DOUBLE NOT NULL DEFAULT 0, `f` FLOAT, `b` BIGINT UNSIGNED NOT NULL DEFAULT 0, `flags` BIT(1) NOT NULL DEFAULT b'0', `d` DATE NULL, `c` CHAR(3) CHARACTER SET latin1 NULL, `bin` VARBINARY(16) NULL, `blob1` LONGBLOB NULL, `ok` BOOLEAN NOT NULL DEFAULT TRUE) ENGINE=InnoDB",
    "CREATE TABLE `banking` (`id` int(11) NOT NULL AUTO_INCREMENT, `identifier` varchar(46) DEFAULT NULL, `type` varchar(50) DEFAULT NULL, `amount` int(64) DEFAULT NULL, `time` bigint(20) DEFAULT NULL, `balance` int(11) DEFAULT 0, `label` varchar(255) DEFAULT NULL, PRIMARY KEY (`id`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
    "ALTER TABLE `banking` ADD INDEX `idx_banking_time` (`time`)",
    "ALTER TABLE `banking` MODIFY COLUMN `identifier` VARCHAR(60) NULL DEFAULT NULL",
    "ALTER TABLE `users` ADD COLUMN `death_time` BIGINT NULL DEFAULT NULL",
    "ALTER TABLE `users` CHANGE `sex` `gender` VARCHAR(2) NOT NULL DEFAULT 'm'",
    "CREATE TABLE `user_licenses` (`id` int(11) NOT NULL AUTO_INCREMENT, `type` varchar(60) NOT NULL, `owner` varchar(60) NOT NULL, PRIMARY KEY (`id`), UNIQUE KEY `uniq_owner_type` (`owner`, `type`))",
    "CREATE TABLE `npwd_calls` (`id` int(11) NOT NULL AUTO_INCREMENT, `identifier` varchar(48) DEFAULT NULL, `transmitter` varchar(255) NOT NULL, `start` varchar(255) DEFAULT NULL, PRIMARY KEY (`id`), KEY `identifier` (`identifier`)) ENGINE=InnoDB AUTO_INCREMENT=31 DEFAULT CHARSET=utf8mb4 COLLATE='utf8mb4_general_ci'"
];

const CASES = [
    {
        "sql": "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
        "params": [
            "users"
        ],
        "expect": [
            {
                "COUNT(*)": 1
            }
        ]
    },
    {
        "sql": "SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
        "params": [
            "banking"
        ],
        "expect": [
            {
                "ENGINE": "InnoDB"
            }
        ]
    },
    {
        "sql": "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
        "params": [
            "users",
            "pincode"
        ],
        "expect": [
            {
                "COUNT(*)": 1
            }
        ]
    },
    {
        "sql": "SELECT DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE, IS_NULLABLE, COLUMN_DEFAULT, COLLATION_NAME, EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
        "params": [
            "users",
            "identifier"
        ],
        "expect": [
            {
                "DATA_TYPE": "varchar",
                "CHARACTER_MAXIMUM_LENGTH": 46,
                "NUMERIC_PRECISION": null,
                "NUMERIC_SCALE": null,
                "IS_NULLABLE": "NO",
                "COLUMN_DEFAULT": null,
                "COLLATION_NAME": "utf8mb4_unicode_ci",
                "EXTRA": ""
            }
        ]
    },
    {
        "sql": "SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE, DATETIME_PRECISION, COLUMN_DEFAULT, COLLATION_NAME, EXTRA, COLUMN_KEY, ORDINAL_POSITION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
        "params": [
            "users"
        ],
        "expect": [
            {
                "COLUMN_NAME": "identifier",
                "DATA_TYPE": "varchar",
                "COLUMN_TYPE": "varchar(46)",
                "IS_NULLABLE": "NO",
                "CHARACTER_MAXIMUM_LENGTH": 46,
                "NUMERIC_PRECISION": null,
                "NUMERIC_SCALE": null,
                "DATETIME_PRECISION": null,
                "COLUMN_DEFAULT": null,
                "COLLATION_NAME": "utf8mb4_unicode_ci",
                "EXTRA": "",
                "COLUMN_KEY": "PRI",
                "ORDINAL_POSITION": 1
            },
            {
                "COLUMN_NAME": "accounts",
                "DATA_TYPE": "longtext",
                "COLUMN_TYPE": "longtext",
                "IS_NULLABLE": "YES",
                "CHARACTER_MAXIMUM_LENGTH": 4294967295,
                "NUMERIC_PRECISION": null,
                "NUMERIC_SCALE": null,
                "DATETIME_PRECISION": null,
                "COLUMN_DEFAULT": "NULL",
                "COLLATION_NAME": "utf8mb4_unicode_ci",
                "EXTRA": "",
                "COLUMN_KEY": "",
                "ORDINAL_POSITION": 2
            },
            {
                "COLUMN_NAME": "group",
                "DATA_TYPE": "varchar",
                "COLUMN_TYPE": "varchar(50)",
                "IS_NULLABLE": "YES",
                "CHARACTER_MAXIMUM_LENGTH": 50,
                "NUMERIC_PRECISION": null,
                "NUMERIC_SCALE": null,
                "DATETIME_PRECISION": null,
                "COLUMN_DEFAULT": "'user'",
                "COLLATION_NAME": "utf8mb4_unicode_ci",
                "EXTRA": "",
                "COLUMN_KEY": "",
                "ORDINAL_POSITION": 3
            },
            {
                "COLUMN_NAME": "job",
                "DATA_TYPE": "varchar",
                "COLUMN_TYPE": "varchar(20)",
                "IS_NULLABLE": "YES",
                "CHARACTER_MAXIMUM_LENGTH": 20,
                "NUMERIC_PRECISION": null,
                "NUMERIC_SCALE": null,
                "DATETIME_PRECISION": null,
                "COLUMN_DEFAULT": "'unemployed'",
                "COLLATION_NAME": "utf8mb4_unicode_ci",
                "EXTRA": "",
                "COLUMN_KEY": "MUL",
                "ORDINAL_POSITION": 4
            },
            {
                "COLUMN_NAME": "job_grade",
                "DATA_TYPE": "int",
                "COLUMN_TYPE": "int(11)",
                "IS_NULLABLE": "YES",
                "CHARACTER_MAXIMUM_LENGTH": null,
                "NUMERIC_PRECISION": 10,
                "NUMERIC_SCALE": 0,
                "DATETIME_PRECISION": null,
                "COLUMN_DEFAULT": "0",
                "COLLATION_NAME": null,
                "EXTRA": "",
                "COLUMN_KEY": "",
                "ORDINAL_POSITION": 5
            },
            {
                "COLUMN_NAME": "position",
                "DATA_TYPE": "longtext",
                "COLUMN_TYPE": "longtext",
                "IS_NULLABLE": "YES",
                "CHARACTER_MAXIMUM_LENGTH": 4294967295,
                "NUMERIC_PRECISION": null,
                "NUMERIC_SCALE": null,
                "DATETIME_PRECISION": null,
                "COLUMN_DEFAULT": "NULL",
                "COLLATION_NAME": "utf8mb4_unicode_ci",
                "EXTRA": "",
                "COLUMN_KEY": "",
                "ORDINAL_POSITION": 6
            },
            {
                "COLUMN_NAME": "firstname",
                "DATA_TYPE": "varchar",
                "COLUMN_TYPE": "varchar(16)",
                "IS_NULLABLE": "YES",
                "CHARACTER_MAXIMUM_LENGTH": 16,
                "NUMERIC_PRECISION": null,
                "NUMERIC_SCALE": null,
                "DATETIME_PRECISION": null,
                "COLUMN_DEFAULT": "NULL",
                "COLLATION_NAME": "utf8mb4_unicode_ci",
                "EXTRA": "",
                "COLUMN_KEY": "",
                "ORDINAL_POSITION": 7
            },
            {
                "COLUMN_NAME": "dateofbirth",
                "DATA_TYPE": "varchar",
                "COLUMN_TYPE": "varchar(10)",
                "IS_NULLABLE": "YES",
                "CHARACTER_MAXIMUM_LENGTH": 10,
                "NUMERIC_PRECISION": null,
                "NUMERIC_SCALE": null,
                "DATETIME_PRECISION": null,
                "COLUMN_DEFAULT": "NULL",
                "COLLATION_NAME": "utf8mb4_unicode_ci",
                "EXTRA": "",
                "COLUMN_KEY": "",
                "ORDINAL_POSITION": 8
            },
            {
                "COLUMN_NAME": "gender",
                "DATA_TYPE": "varchar",
                "COLUMN_TYPE": "varchar(2)",
                "IS_NULLABLE": "NO",
                "CHARACTER_MAXIMUM_LENGTH": 2,
                "NUMERIC_PRECISION": null,
                "NUMERIC_SCALE": null,
                "DATETIME_PRECISION": null,
                "COLUMN_DEFAULT": "'m'",
                "COLLATION_NAME": "utf8mb4_unicode_ci",
                "EXTRA": "",
                "COLUMN_KEY": "",
                "ORDINAL_POSITION": 9
            },
            {
                "COLUMN_NAME": "height",
                "DATA_TYPE": "int",
                "COLUMN_TYPE": "int(11)",
                "IS_NULLABLE": "YES",
                "CHARACTER_MAXIMUM_LENGTH": null,
                "NUMERIC_PRECISION": 10,
                "NUMERIC_SCALE": 0,
                "DATETIME_PRECISION": null,
                "COLUMN_DEFAULT": "NULL",
                "COLLATION_NAME": null,
                "EXTRA": "",
                "COLUMN_KEY": "",
                "ORDINAL_POSITION": 10
            },
            {
                "COLUMN_NAME": "skin",
                "DATA_TYPE": "longtext",
                "COLUMN_TYPE": "longtext",
                "IS_NULLABLE": "YES",
                "CHARACTER_MAXIMUM_LENGTH": 4294967295,
                "NUMERIC_PRECISION": null,
                "NUMERIC_SCALE": null,
                "DATETIME_PRECISION": null,
                "COLUMN_DEFAULT": "NULL",
                "COLLATION_NAME": "utf8mb4_unicode_ci",
                "EXTRA": "",
                "COLUMN_KEY": "",
                "ORDINAL_POSITION": 11
            },
            {
                "COLUMN_NAME": "status",
                "DATA_TYPE": "longtext",
                "COLUMN_TYPE": "longtext",
                "IS_NULLABLE": "YES",
                "CHARACTER_MAXIMUM_LENGTH": 4294967295,
                "NUMERIC_PRECISION": null,
                "NUMERIC_SCALE": null,
                "DATETIME_PRECISION": null,
                "COLUMN_DEFAULT": "NULL",
                "COLLATION_NAME": "utf8mb4_unicode_ci",
                "EXTRA": "",
                "COLUMN_KEY": "",
                "ORDINAL_POSITION": 12
            },
            {
                "COLUMN_NAME": "is_dead",
                "DATA_TYPE": "tinyint",
                "COLUMN_TYPE": "tinyint(1)",
                "IS_NULLABLE": "YES",
                "CHARACTER_MAXIMUM_LENGTH": null,
                "NUMERIC_PRECISION": 3,
                "NUMERIC_SCALE": 0,
                "DATETIME_PRECISION": null,
                "COLUMN_DEFAULT": "0",
                "COLLATION_NAME": null,
                "EXTRA": "",
                "COLUMN_KEY": "",
                "ORDINAL_POSITION": 13
            },
            {
                "COLUMN_NAME": "id",
                "DATA_TYPE": "int",
                "COLUMN_TYPE": "int(11)",
                "IS_NULLABLE": "NO",
                "CHARACTER_MAXIMUM_LENGTH": null,
                "NUMERIC_PRECISION": 10,
                "NUMERIC_SCALE": 0,
                "DATETIME_PRECISION": null,
                "COLUMN_DEFAULT": null,
                "COLLATION_NAME": null,
                "EXTRA": "auto_increment",
                "COLUMN_KEY": "UNI",
                "ORDINAL_POSITION": 14
            },
            {
                "COLUMN_NAME": "disabled",
                "DATA_TYPE": "tinyint",
                "COLUMN_TYPE": "tinyint(1)",
                "IS_NULLABLE": "YES",
                "CHARACTER_MAXIMUM_LENGTH": null,
                "NUMERIC_PRECISION": 3,
                "NUMERIC_SCALE": 0,
                "DATETIME_PRECISION": null,
                "COLUMN_DEFAULT": "0",
                "COLLATION_NAME": null,
                "EXTRA": "",
                "COLUMN_KEY": "",
                "ORDINAL_POSITION": 15
            },
            {
                "COLUMN_NAME": "last_seen",
                "DATA_TYPE": "timestamp",
                "COLUMN_TYPE": "timestamp",
                "IS_NULLABLE": "YES",
                "CHARACTER_MAXIMUM_LENGTH": null,
                "NUMERIC_PRECISION": null,
                "NUMERIC_SCALE": null,
                "DATETIME_PRECISION": 0,
                "COLUMN_DEFAULT": "current_timestamp()",
                "COLLATION_NAME": null,
                "EXTRA": "on update current_timestamp()",
                "COLUMN_KEY": "",
                "ORDINAL_POSITION": 16
            },
            {
                "COLUMN_NAME": "money",
                "DATA_TYPE": "decimal",
                "COLUMN_TYPE": "decimal(10,2)",
                "IS_NULLABLE": "NO",
                "CHARACTER_MAXIMUM_LENGTH": null,
                "NUMERIC_PRECISION": 10,
                "NUMERIC_SCALE": 2,
                "DATETIME_PRECISION": null,
                "COLUMN_DEFAULT": "0.00",
                "COLLATION_NAME": null,
                "EXTRA": "",
                "COLUMN_KEY": "",
                "ORDINAL_POSITION": 17
            },
            {
                "COLUMN_NAME": "pincode",
                "DATA_TYPE": "int",
                "COLUMN_TYPE": "int(10) unsigned",
                "IS_NULLABLE": "YES",
                "CHARACTER_MAXIMUM_LENGTH": null,
                "NUMERIC_PRECISION": 10,
                "NUMERIC_SCALE": 0,
                "DATETIME_PRECISION": null,
                "COLUMN_DEFAULT": "NULL",
                "COLLATION_NAME": null,
                "EXTRA": "",
                "COLUMN_KEY": "",
                "ORDINAL_POSITION": 18
            },
            {
                "COLUMN_NAME": "meta",
                "DATA_TYPE": "longtext",
                "COLUMN_TYPE": "longtext",
                "IS_NULLABLE": "YES",
                "CHARACTER_MAXIMUM_LENGTH": 4294967295,
                "NUMERIC_PRECISION": null,
                "NUMERIC_SCALE": null,
                "DATETIME_PRECISION": null,
                "COLUMN_DEFAULT": "NULL",
                "COLLATION_NAME": "utf8mb4_bin",
                "EXTRA": "",
                "COLUMN_KEY": "",
                "ORDINAL_POSITION": 19
            },
            {
                "COLUMN_NAME": "created_at",
                "DATA_TYPE": "datetime",
                "COLUMN_TYPE": "datetime(3)",
                "IS_NULLABLE": "NO",
                "CHARACTER_MAXIMUM_LENGTH": null,
                "NUMERIC_PRECISION": null,
                "NUMERIC_SCALE": null,
                "DATETIME_PRECISION": 3,
                "COLUMN_DEFAULT": "current_timestamp(3)",
                "COLLATION_NAME": null,
                "EXTRA": "",
                "COLUMN_KEY": "",
                "ORDINAL_POSITION": 20
            },
            {
                "COLUMN_NAME": "death_time",
                "DATA_TYPE": "bigint",
                "COLUMN_TYPE": "bigint(20)",
                "IS_NULLABLE": "YES",
                "CHARACTER_MAXIMUM_LENGTH": null,
                "NUMERIC_PRECISION": 19,
                "NUMERIC_SCALE": 0,
                "DATETIME_PRECISION": null,
                "COLUMN_DEFAULT": "NULL",
                "COLLATION_NAME": null,
                "EXTRA": "",
                "COLUMN_KEY": "",
                "ORDINAL_POSITION": 21
            }
        ]
    },
    {
        "sql": "SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE, COLUMN_DEFAULT, COLLATION_NAME, EXTRA, COLUMN_KEY FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
        "params": [
            "mdt_warrant_requests"
        ],
        "expect": [
            {
                "COLUMN_NAME": "id",
                "DATA_TYPE": "int",
                "COLUMN_TYPE": "int(11)",
                "IS_NULLABLE": "NO",
                "CHARACTER_MAXIMUM_LENGTH": null,
                "NUMERIC_PRECISION": 10,
                "NUMERIC_SCALE": 0,
                "COLUMN_DEFAULT": null,
                "COLLATION_NAME": null,
                "EXTRA": "auto_increment",
                "COLUMN_KEY": "PRI"
            },
            {
                "COLUMN_NAME": "status",
                "DATA_TYPE": "enum",
                "COLUMN_TYPE": "enum('pending','approved','denied','closed')",
                "IS_NULLABLE": "NO",
                "CHARACTER_MAXIMUM_LENGTH": 8,
                "NUMERIC_PRECISION": null,
                "NUMERIC_SCALE": null,
                "COLUMN_DEFAULT": "'pending'",
                "COLLATION_NAME": "utf8mb4_general_ci",
                "EXTRA": "",
                "COLUMN_KEY": ""
            },
            {
                "COLUMN_NAME": "notes",
                "DATA_TYPE": "text",
                "COLUMN_TYPE": "text",
                "IS_NULLABLE": "YES",
                "CHARACTER_MAXIMUM_LENGTH": 65535,
                "NUMERIC_PRECISION": null,
                "NUMERIC_SCALE": null,
                "COLUMN_DEFAULT": "NULL",
                "COLLATION_NAME": "utf8mb4_general_ci",
                "EXTRA": "",
                "COLUMN_KEY": ""
            },
            {
                "COLUMN_NAME": "amount",
                "DATA_TYPE": "double",
                "COLUMN_TYPE": "double",
                "IS_NULLABLE": "NO",
                "CHARACTER_MAXIMUM_LENGTH": null,
                "NUMERIC_PRECISION": 22,
                "NUMERIC_SCALE": null,
                "COLUMN_DEFAULT": "0",
                "COLLATION_NAME": null,
                "EXTRA": "",
                "COLUMN_KEY": ""
            },
            {
                "COLUMN_NAME": "f",
                "DATA_TYPE": "float",
                "COLUMN_TYPE": "float",
                "IS_NULLABLE": "YES",
                "CHARACTER_MAXIMUM_LENGTH": null,
                "NUMERIC_PRECISION": 12,
                "NUMERIC_SCALE": null,
                "COLUMN_DEFAULT": "NULL",
                "COLLATION_NAME": null,
                "EXTRA": "",
                "COLUMN_KEY": ""
            },
            {
                "COLUMN_NAME": "b",
                "DATA_TYPE": "bigint",
                "COLUMN_TYPE": "bigint(20) unsigned",
                "IS_NULLABLE": "NO",
                "CHARACTER_MAXIMUM_LENGTH": null,
                "NUMERIC_PRECISION": 20,
                "NUMERIC_SCALE": 0,
                "COLUMN_DEFAULT": "0",
                "COLLATION_NAME": null,
                "EXTRA": "",
                "COLUMN_KEY": ""
            },
            {
                "COLUMN_NAME": "flags",
                "DATA_TYPE": "bit",
                "COLUMN_TYPE": "bit(1)",
                "IS_NULLABLE": "NO",
                "CHARACTER_MAXIMUM_LENGTH": null,
                "NUMERIC_PRECISION": 1,
                "NUMERIC_SCALE": null,
                "COLUMN_DEFAULT": "b'0'",
                "COLLATION_NAME": null,
                "EXTRA": "",
                "COLUMN_KEY": ""
            },
            {
                "COLUMN_NAME": "d",
                "DATA_TYPE": "date",
                "COLUMN_TYPE": "date",
                "IS_NULLABLE": "YES",
                "CHARACTER_MAXIMUM_LENGTH": null,
                "NUMERIC_PRECISION": null,
                "NUMERIC_SCALE": null,
                "COLUMN_DEFAULT": "NULL",
                "COLLATION_NAME": null,
                "EXTRA": "",
                "COLUMN_KEY": ""
            },
            {
                "COLUMN_NAME": "c",
                "DATA_TYPE": "char",
                "COLUMN_TYPE": "char(3)",
                "IS_NULLABLE": "YES",
                "CHARACTER_MAXIMUM_LENGTH": 3,
                "NUMERIC_PRECISION": null,
                "NUMERIC_SCALE": null,
                "COLUMN_DEFAULT": "NULL",
                "COLLATION_NAME": "latin1_swedish_ci",
                "EXTRA": "",
                "COLUMN_KEY": ""
            },
            {
                "COLUMN_NAME": "bin",
                "DATA_TYPE": "varbinary",
                "COLUMN_TYPE": "varbinary(16)",
                "IS_NULLABLE": "YES",
                "CHARACTER_MAXIMUM_LENGTH": 16,
                "NUMERIC_PRECISION": null,
                "NUMERIC_SCALE": null,
                "COLUMN_DEFAULT": "NULL",
                "COLLATION_NAME": null,
                "EXTRA": "",
                "COLUMN_KEY": ""
            },
            {
                "COLUMN_NAME": "blob1",
                "DATA_TYPE": "longblob",
                "COLUMN_TYPE": "longblob",
                "IS_NULLABLE": "YES",
                "CHARACTER_MAXIMUM_LENGTH": 4294967295,
                "NUMERIC_PRECISION": null,
                "NUMERIC_SCALE": null,
                "COLUMN_DEFAULT": "NULL",
                "COLLATION_NAME": null,
                "EXTRA": "",
                "COLUMN_KEY": ""
            },
            {
                "COLUMN_NAME": "ok",
                "DATA_TYPE": "tinyint",
                "COLUMN_TYPE": "tinyint(1)",
                "IS_NULLABLE": "NO",
                "CHARACTER_MAXIMUM_LENGTH": null,
                "NUMERIC_PRECISION": 3,
                "NUMERIC_SCALE": 0,
                "COLUMN_DEFAULT": "1",
                "COLLATION_NAME": null,
                "EXTRA": "",
                "COLUMN_KEY": ""
            }
        ]
    },
    {
        "sql": "SELECT COLUMN_NAME, COLUMN_TYPE, CHARACTER_MAXIMUM_LENGTH, COLUMN_DEFAULT, COLUMN_KEY, EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'banking' ORDER BY ORDINAL_POSITION",
        "params": [],
        "expect": [
            {
                "COLUMN_NAME": "id",
                "COLUMN_TYPE": "int(11)",
                "CHARACTER_MAXIMUM_LENGTH": null,
                "COLUMN_DEFAULT": null,
                "COLUMN_KEY": "PRI",
                "EXTRA": "auto_increment"
            },
            {
                "COLUMN_NAME": "identifier",
                "COLUMN_TYPE": "varchar(60)",
                "CHARACTER_MAXIMUM_LENGTH": 60,
                "COLUMN_DEFAULT": "NULL",
                "COLUMN_KEY": "",
                "EXTRA": ""
            },
            {
                "COLUMN_NAME": "type",
                "COLUMN_TYPE": "varchar(50)",
                "CHARACTER_MAXIMUM_LENGTH": 50,
                "COLUMN_DEFAULT": "NULL",
                "COLUMN_KEY": "",
                "EXTRA": ""
            },
            {
                "COLUMN_NAME": "amount",
                "COLUMN_TYPE": "int(64)",
                "CHARACTER_MAXIMUM_LENGTH": null,
                "COLUMN_DEFAULT": "NULL",
                "COLUMN_KEY": "",
                "EXTRA": ""
            },
            {
                "COLUMN_NAME": "time",
                "COLUMN_TYPE": "bigint(20)",
                "CHARACTER_MAXIMUM_LENGTH": null,
                "COLUMN_DEFAULT": "NULL",
                "COLUMN_KEY": "MUL",
                "EXTRA": ""
            },
            {
                "COLUMN_NAME": "balance",
                "COLUMN_TYPE": "int(11)",
                "CHARACTER_MAXIMUM_LENGTH": null,
                "COLUMN_DEFAULT": "0",
                "COLUMN_KEY": "",
                "EXTRA": ""
            },
            {
                "COLUMN_NAME": "label",
                "COLUMN_TYPE": "varchar(255)",
                "CHARACTER_MAXIMUM_LENGTH": 255,
                "COLUMN_DEFAULT": "NULL",
                "COLUMN_KEY": "",
                "EXTRA": ""
            }
        ]
    },
    {
        "sql": "SELECT COLUMN_TYPE AS coltype FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mdt_warrant_requests' AND COLUMN_NAME = 'status'",
        "params": [],
        "expect": [
            {
                "coltype": "enum('pending','approved','denied','closed')"
            }
        ]
    },
    {
        "sql": "SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'mdt\\_%' ORDER BY TABLE_NAME, COLUMN_NAME",
        "params": [],
        "expect": [
            {
                "TABLE_NAME": "mdt_warrant_requests",
                "COLUMN_NAME": "amount"
            },
            {
                "TABLE_NAME": "mdt_warrant_requests",
                "COLUMN_NAME": "b"
            },
            {
                "TABLE_NAME": "mdt_warrant_requests",
                "COLUMN_NAME": "bin"
            },
            {
                "TABLE_NAME": "mdt_warrant_requests",
                "COLUMN_NAME": "blob1"
            },
            {
                "TABLE_NAME": "mdt_warrant_requests",
                "COLUMN_NAME": "c"
            },
            {
                "TABLE_NAME": "mdt_warrant_requests",
                "COLUMN_NAME": "d"
            },
            {
                "TABLE_NAME": "mdt_warrant_requests",
                "COLUMN_NAME": "f"
            },
            {
                "TABLE_NAME": "mdt_warrant_requests",
                "COLUMN_NAME": "flags"
            },
            {
                "TABLE_NAME": "mdt_warrant_requests",
                "COLUMN_NAME": "id"
            },
            {
                "TABLE_NAME": "mdt_warrant_requests",
                "COLUMN_NAME": "notes"
            },
            {
                "TABLE_NAME": "mdt_warrant_requests",
                "COLUMN_NAME": "ok"
            },
            {
                "TABLE_NAME": "mdt_warrant_requests",
                "COLUMN_NAME": "status"
            }
        ]
    },
    {
        "sql": "SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? AND SEQ_IN_INDEX = 1 AND SUB_PART IS NULL",
        "params": [
            "banking",
            "time"
        ],
        "expect": [
            {
                "COUNT(*)": 1
            }
        ]
    },
    {
        "sql": "SELECT INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME, NON_UNIQUE, NULLABLE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX",
        "params": [
            "users"
        ],
        "expect": [
            {
                "INDEX_NAME": "id",
                "SEQ_IN_INDEX": 1,
                "COLUMN_NAME": "id",
                "NON_UNIQUE": 0,
                "NULLABLE": ""
            },
            {
                "INDEX_NAME": "idx_job",
                "SEQ_IN_INDEX": 1,
                "COLUMN_NAME": "job",
                "NON_UNIQUE": 1,
                "NULLABLE": "YES"
            },
            {
                "INDEX_NAME": "idx_job",
                "SEQ_IN_INDEX": 2,
                "COLUMN_NAME": "job_grade",
                "NON_UNIQUE": 1,
                "NULLABLE": "YES"
            },
            {
                "INDEX_NAME": "PRIMARY",
                "SEQ_IN_INDEX": 1,
                "COLUMN_NAME": "identifier",
                "NON_UNIQUE": 0,
                "NULLABLE": ""
            }
        ]
    },
    {
        "sql": "SELECT INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME, NON_UNIQUE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX",
        "params": [
            "npwd_calls"
        ],
        "expect": [
            {
                "INDEX_NAME": "identifier",
                "SEQ_IN_INDEX": 1,
                "COLUMN_NAME": "identifier",
                "NON_UNIQUE": 1
            },
            {
                "INDEX_NAME": "PRIMARY",
                "SEQ_IN_INDEX": 1,
                "COLUMN_NAME": "id",
                "NON_UNIQUE": 0
            }
        ]
    },
    {
        "sql": "SELECT COUNT(*) FROM ( SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_licenses' AND NON_UNIQUE = 0 GROUP BY INDEX_NAME HAVING COUNT(*) = 2 AND SUM(SUB_PART IS NOT NULL) = 0 AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) = 'owner,type' ) AS t",
        "params": [],
        "expect": [
            {
                "COUNT(*)": 1
            }
        ]
    },
    {
        "sql": "SELECT GROUP_CONCAT(COALESCE(COLUMN_NAME, '<expression>') ORDER BY SEQ_IN_INDEX) AS columns_list FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'banking' GROUP BY INDEX_NAME HAVING SUM(SUB_PART IS NOT NULL) = 0 ORDER BY columns_list",
        "params": [],
        "expect": [
            {
                "columns_list": "id"
            },
            {
                "columns_list": "time"
            }
        ]
    },
    {
        "sql": "SELECT EXISTS (SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME = 'banking') AS e",
        "params": [],
        "expect": [
            {
                "e": 1
            }
        ]
    },
    {
        "sql": "SELECT 1 AS x FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
        "params": [
            "users",
            "missing"
        ],
        "expect": []
    },
    {
        "sql": "SHOW COLUMNS FROM `banking`",
        "params": [],
        "expect": [
            {
                "Field": "id",
                "Type": "int(11)",
                "Null": "NO",
                "Key": "PRI",
                "Default": null,
                "Extra": "auto_increment"
            },
            {
                "Field": "identifier",
                "Type": "varchar(60)",
                "Null": "YES",
                "Key": "",
                "Default": null,
                "Extra": ""
            },
            {
                "Field": "type",
                "Type": "varchar(50)",
                "Null": "YES",
                "Key": "",
                "Default": null,
                "Extra": ""
            },
            {
                "Field": "amount",
                "Type": "int(64)",
                "Null": "YES",
                "Key": "",
                "Default": null,
                "Extra": ""
            },
            {
                "Field": "time",
                "Type": "bigint(20)",
                "Null": "YES",
                "Key": "MUL",
                "Default": null,
                "Extra": ""
            },
            {
                "Field": "balance",
                "Type": "int(11)",
                "Null": "YES",
                "Key": "",
                "Default": "0",
                "Extra": ""
            },
            {
                "Field": "label",
                "Type": "varchar(255)",
                "Null": "YES",
                "Key": "",
                "Default": null,
                "Extra": ""
            }
        ]
    },
    {
        "sql": "SHOW COLUMNS FROM users LIKE 'job%'",
        "params": [],
        "expect": [
            {
                "Field": "job",
                "Type": "varchar(20)",
                "Null": "YES",
                "Key": "MUL",
                "Default": "unemployed",
                "Extra": ""
            },
            {
                "Field": "job_grade",
                "Type": "int(11)",
                "Null": "YES",
                "Key": "",
                "Default": "0",
                "Extra": ""
            }
        ]
    },
    {
        "sql": "SELECT DATABASE() = (SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = DATABASE()) AS same",
        "params": [],
        "expect": [
            {
                "same": 1
            }
        ]
    }
];

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-info-'));
    const mariaFile = path.join(dir, 'maria.sqlite');
    new DatabaseSync(mariaFile).close();
    process.env.FX_RES_DIR = dir;
    process.env.FX_MARIA_FILE = mariaFile;
    const fx = require('../harness/fx.js');
    if (!(await fx.ready(20000))) throw new Error('engine not ready');
    const call = (sql, params) => new Promise((done) => fx.registry.query(sql, params, (v, err) => done({ v, err: err || null }), 'test', true));
    for (const sql of DDL) {
        const r = await call(sql, []);
        check('DDL ' + sql.slice(0, 60), r.v !== false, r.err);
    }
    for (const c of CASES) {
        const r = await call(c.sql, c.params);
        const got = JSON.stringify(r.v);
        const want = JSON.stringify(c.expect);
        check(c.sql.replace(/s+/g, ' ').slice(0, 90), got === want, got === want ? '' : 'got ' + got + ' want ' + want);
    }
    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
    setTimeout(() => {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* Windows keeps the file open */ }
        process.exit(failed ? 1 : 0);
    }, 200);
})().catch((e) => { console.log('FAIL engine ' + e.stack); process.exit(1); });
