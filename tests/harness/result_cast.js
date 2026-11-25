'use strict';

// The result values an oxmysql-compatible API gives, by column type, for the
// tests that read MariaDB through mysql2 directly. Written from the observed
// results (tests/repro/type_casts.js), not from any other project's code:
// DATETIME and TIMESTAMP as epoch ms, DATE as ms at local midnight,
// TINYINT(1) and a one-bit BIT as a boolean, a wider BIT as its first byte,
// a binary BLOB as an array of bytes. executeCast turns the dates only.

const toEpoch = (text) => {
    if (text === null || text === '') {
        return null;
    }
    return new Date(text).getTime();
};

const dateTime = (field) => toEpoch(field.string());

const dateOnly = (field) => {
    const text = field.string();
    if (text === null || text === '') {
        return null;
    }
    return new Date(text + ' 00:00:00').getTime();
};

const tiny = (field, next) => {
    if (field.length !== 1) {
        return next();
    }
    const text = field.string();
    return text === null ? null : text === '1';
};

const blob = (field) => {
    if (field.charset === 63) {
        const buf = field.buffer();
        return buf === null ? null : Array.from(buf);
    }
    return field.string();
};

const dateTimeTypes = ['DATETIME', 'DATETIME2', 'TIMESTAMP', 'TIMESTAMP2', 'NEWDATE'];
const blobTypes = ['TINY_BLOB', 'MEDIUM_BLOB', 'LONG_BLOB', 'BLOB'];

// Converters shared by both protocols.
const dateConverters = Object.create(null);
for (const name of dateTimeTypes) {
    dateConverters[name] = dateTime;
}
dateConverters.DATE = dateOnly;

// Converters keyed by mysql2 type name, text protocol.
const converters = Object.create(null);
Object.assign(converters, dateConverters);
converters.TINY = tiny;
for (const name of blobTypes) {
    converters[name] = blob;
}

const makeBit = (bitBy) => (field) => {
    const buf = field.buffer();
    if (buf === null) {
        return null;
    }
    const oneBit = bitBy === 'buffer' ? buf.length === 1 : field.length === 1;
    return oneBit ? buf[0] === 1 : buf[0];
};

const makeQueryCast = ({ bitBy } = {}) => {
    const table = Object.assign(Object.create(null), converters, { BIT: makeBit(bitBy) });
    return (field, next) => {
        const convert = table[field.type];
        return convert ? convert(field, next) : next();
    };
};

const executeCast = (field, next) => {
    const convert = dateConverters[field.type];
    return convert ? convert(field, next) : next();
};

module.exports = { converters, makeQueryCast, executeCast };
