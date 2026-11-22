/*! selfbase-js. Bundles postgrest-js and supabase-js type code, MIT License, Copyright (c) 2020 Supabase. */
export declare class PostgrestError extends Error {
    details: string;
    hint: string;
    code: string;
    constructor(context: {
        message: string;
        details: string;
        hint: string;
        code: string;
    });
    toJSON(): {
        name: string;
        message: string;
        details: string;
        hint: string;
        code: string;
    };
}
type Fetch = typeof fetch;
type GenericRelationship = {
    foreignKeyName: string;
    columns: string[];
    isOneToOne?: boolean;
    referencedRelation: string;
    referencedColumns: string[];
};
type GenericTable = {
    Row: Record<string, unknown>;
    Insert: Record<string, unknown>;
    Update: Record<string, unknown>;
    Relationships: GenericRelationship[];
};
type GenericUpdatableView = {
    Row: Record<string, unknown>;
    Insert: Record<string, unknown>;
    Update: Record<string, unknown>;
    Relationships: GenericRelationship[];
};
type GenericNonUpdatableView = {
    Row: Record<string, unknown>;
    Relationships: GenericRelationship[];
};
type GenericView = GenericUpdatableView | GenericNonUpdatableView;
type GenericSetofOption = {
    isSetofReturn?: boolean | undefined;
    isOneToOne?: boolean | undefined;
    isNotNullable?: boolean | undefined;
    to: string;
    from: string;
};
type GenericFunction = {
    Args: Record<string, unknown> | never;
    Returns: unknown;
    SetofOptions?: GenericSetofOption;
};
export type GenericSchema = {
    Tables: Record<string, GenericTable>;
    Views: Record<string, GenericView>;
    Functions: Record<string, GenericFunction>;
};
type ClientServerOptions = {
    PostgrestVersion?: string;
};
type AggregateWithoutColumnFunctions = "count";
type AggregateWithColumnFunctions = "sum" | "avg" | "min" | "max" | AggregateWithoutColumnFunctions;
type AggregateFunctions = AggregateWithColumnFunctions;
type Json = string | number | boolean | null | {
    [key: string]: Json | undefined;
} | Json[];
type PostgresSQLNumberTypes = "int2" | "int4" | "int8" | "float4" | "float8" | "numeric";
type PostgresSQLStringTypes = "bytea" | "bpchar" | "varchar" | "date" | "text" | "citext" | "time" | "timetz" | "timestamp" | "timestamptz" | "uuid" | "vector";
type SingleValuePostgreSQLTypes = PostgresSQLNumberTypes | PostgresSQLStringTypes | "bool" | "json" | "jsonb" | "void" | "record" | string;
type ArrayPostgreSQLTypes = `_${SingleValuePostgreSQLTypes}`;
type TypeScriptSingleValueTypes<T extends SingleValuePostgreSQLTypes> = T extends "bool" ? boolean : T extends PostgresSQLNumberTypes ? number : T extends PostgresSQLStringTypes ? string : T extends "json" | "jsonb" ? Json : T extends "void" ? undefined : T extends "record" ? Record<string, unknown> : unknown;
type StripUnderscore<T extends string> = T extends `_${infer U}` ? U : T;
type PostgreSQLTypes = SingleValuePostgreSQLTypes | ArrayPostgreSQLTypes;
type TypeScriptTypes<T extends PostgreSQLTypes> = T extends ArrayPostgreSQLTypes ? TypeScriptSingleValueTypes<StripUnderscore<Extract<T, SingleValuePostgreSQLTypes>>>[] : TypeScriptSingleValueTypes<T>;
type UnionToIntersection<U> = (U extends any ? (k: U) => void : never) extends (k: infer I) => void ? I : never;
type LastOf<T> = UnionToIntersection<T extends any ? () => T : never> extends () => infer R ? R : never;
type Push<T extends any[], V> = [
    ...T,
    V
];
type UnionToTuple<T, L = LastOf<T>, N = [
    T
] extends [
    never
] ? true : false> = N extends true ? [
] : Push<UnionToTuple<Exclude<T, L>>, L>;
type UnionToArray<T> = UnionToTuple<T>;
type ExtractFirstProperty<T> = T extends {
    [K in keyof T]: infer U;
} ? U : never;
type ContainsNull<T> = null extends T ? true : false;
type IsNonEmptyArray<T> = Exclude<T, undefined> extends readonly [
    unknown,
    ...unknown[]
] ? true : false;
type TablesAndViews<Schema extends GenericSchema> = Schema["Tables"] & Exclude<Schema["Views"], "">;
type ParseQuery<Query extends string> = string extends Query ? GenericStringError : ParseNodes<EatWhitespace<Query>> extends [
    infer Nodes,
    `${infer Remainder}`
] ? Nodes extends Ast.Node[] ? EatWhitespace<Remainder> extends "" ? SimplifyDeep<Nodes> : ParserError<`Unexpected input: ${Remainder}`> : ParserError<"Invalid nodes array structure"> : ParseNodes<EatWhitespace<Query>>;
type ParseNodes<Input extends string> = string extends Input ? GenericStringError : ParseNodesHelper<Input, [
]>;
type ParseNodesHelper<Input extends string, Nodes extends Ast.Node[]> = ParseNode<Input> extends [
    infer Node,
    `${infer Remainder}`
] ? Node extends Ast.Node ? EatWhitespace<Remainder> extends `,${infer Remainder}` ? ParseNodesHelper<EatWhitespace<Remainder>, [
    ...Nodes,
    Node
]> : [
    [
        ...Nodes,
        Node
    ],
    EatWhitespace<Remainder>
] : ParserError<"Invalid node type in nodes helper"> : ParseNode<Input>;
type ParseNode<Input extends string> = Input extends "" ? ParserError<"Empty string"> : Input extends `*${infer Remainder}` ? [
    Ast.StarNode,
    EatWhitespace<Remainder>
] : Input extends `...${infer Remainder}` ? ParseField<EatWhitespace<Remainder>> extends [
    infer TargetField,
    `${infer Remainder}`
] ? TargetField extends Ast.FieldNode ? [
    {
        type: "spread";
        target: TargetField;
    },
    EatWhitespace<Remainder>
] : ParserError<"Invalid target field type in spread"> : ParserError<`Unable to parse spread resource at \`${Input}\``> : ParseIdentifier<Input> extends [
    infer NameOrAlias,
    `${infer Remainder}`
] ? EatWhitespace<Remainder> extends `::${infer _}` ? ParseField<Input> : EatWhitespace<Remainder> extends `:${infer Remainder}` ? ParseField<EatWhitespace<Remainder>> extends [
    infer Field,
    `${infer Remainder}`
] ? Field extends Ast.FieldNode ? [
    Omit<Field, "alias"> & {
        alias: NameOrAlias;
    },
    EatWhitespace<Remainder>
] : ParserError<"Invalid field type in alias parsing"> : ParserError<`Unable to parse renamed field at \`${Input}\``> : ParseField<Input> : ParserError<`Expected identifier at \`${Input}\``>;
type ParseField<Input extends string> = Input extends "" ? ParserError<"Empty string"> : ParseIdentifier<Input> extends [
    infer Name,
    `${infer Remainder}`
] ? Name extends "count" ? ParseCountField<Input> : Remainder extends `!inner${infer Remainder}` ? ParseEmbeddedResource<EatWhitespace<Remainder>> extends [
    infer Children,
    `${infer Remainder}`
] ? Children extends Ast.Node[] ? [
    {
        type: "field";
        name: Name;
        innerJoin: true;
        children: Children;
    },
    Remainder
] : ParserError<"Invalid children array in inner join"> : CreateParserErrorIfRequired<ParseEmbeddedResource<EatWhitespace<Remainder>>, `Expected embedded resource after "!inner" at \`${Remainder}\``> : EatWhitespace<Remainder> extends `!left${infer Remainder}` ? ParseEmbeddedResource<EatWhitespace<Remainder>> extends [
    infer Children,
    `${infer Remainder}`
] ? Children extends Ast.Node[] ? [
    {
        type: "field";
        name: Name;
        children: Children;
    },
    EatWhitespace<Remainder>
] : ParserError<"Invalid children array in left join"> : CreateParserErrorIfRequired<ParseEmbeddedResource<EatWhitespace<Remainder>>, `Expected embedded resource after "!left" at \`${EatWhitespace<Remainder>}\``> : EatWhitespace<Remainder> extends `!${infer Remainder}` ? ParseIdentifier<EatWhitespace<Remainder>> extends [
    infer Hint,
    `${infer Remainder}`
] ? EatWhitespace<Remainder> extends `!inner${infer Remainder}` ? ParseEmbeddedResource<EatWhitespace<Remainder>> extends [
    infer Children,
    `${infer Remainder}`
] ? Children extends Ast.Node[] ? [
    {
        type: "field";
        name: Name;
        hint: Hint;
        innerJoin: true;
        children: Children;
    },
    EatWhitespace<Remainder>
] : ParserError<"Invalid children array in hint inner join"> : ParseEmbeddedResource<EatWhitespace<Remainder>> : ParseEmbeddedResource<EatWhitespace<Remainder>> extends [
    infer Children,
    `${infer Remainder}`
] ? Children extends Ast.Node[] ? [
    {
        type: "field";
        name: Name;
        hint: Hint;
        children: Children;
    },
    EatWhitespace<Remainder>
] : ParserError<"Invalid children array in hint"> : ParseEmbeddedResource<EatWhitespace<Remainder>> : ParserError<`Expected identifier after "!" at \`${EatWhitespace<Remainder>}\``> : EatWhitespace<Remainder> extends `(${infer _}` ? ParseEmbeddedResource<EatWhitespace<Remainder>> extends [
    infer Children,
    `${infer Remainder}`
] ? Children extends Ast.Node[] ? [
    {
        type: "field";
        name: Name;
        children: Children;
    },
    EatWhitespace<Remainder>
] : ParserError<"Invalid children array in field"> : ParseEmbeddedResource<EatWhitespace<Remainder>> : ParseNonEmbeddedResourceField<Input> : ParserError<`Expected identifier at \`${Input}\``>;
type ParseCountField<Input extends string> = ParseIdentifier<Input> extends [
    "count",
    `${infer Remainder}`
] ? (EatWhitespace<Remainder> extends `()${infer Remainder_}` ? EatWhitespace<Remainder_> : EatWhitespace<Remainder>) extends `${infer Remainder}` ? Remainder extends `::${infer _}` ? ParseFieldTypeCast<Remainder> extends [
    infer CastType,
    `${infer Remainder}`
] ? [
    {
        type: "field";
        name: "count";
        aggregateFunction: "count";
        castType: CastType;
    },
    Remainder
] : ParseFieldTypeCast<Remainder> : [
    {
        type: "field";
        name: "count";
        aggregateFunction: "count";
    },
    Remainder
] : never : ParserError<`Expected "count" at \`${Input}\``>;
type ParseEmbeddedResource<Input extends string> = Input extends `(${infer Remainder}` ? EatWhitespace<Remainder> extends `)${infer Remainder}` ? [
    [
    ],
    EatWhitespace<Remainder>
] : ParseNodes<EatWhitespace<Remainder>> extends [
    infer Nodes,
    `${infer Remainder}`
] ? Nodes extends Ast.Node[] ? EatWhitespace<Remainder> extends `)${infer Remainder}` ? [
    Nodes,
    EatWhitespace<Remainder>
] : ParserError<`Expected ")" at \`${EatWhitespace<Remainder>}\``> : ParserError<"Invalid nodes array in embedded resource"> : ParseNodes<EatWhitespace<Remainder>> : ParserError<`Expected "(" at \`${Input}\``>;
type ParseNonEmbeddedResourceField<Input extends string> = ParseIdentifier<Input> extends [
    infer Name,
    `${infer Remainder}`
] ? (Remainder extends `->${infer PathAndRest}` ? ParseJsonAccessor<Remainder> extends [
    infer PropertyName,
    infer PropertyType,
    `${infer Remainder}`
] ? [
    {
        type: "field";
        name: Name;
        alias: PropertyName;
        castType: PropertyType;
        jsonPath: JsonPathToAccessor<PathAndRest extends `${infer Path},${string}` ? Path : PathAndRest>;
    },
    Remainder
] : ParseJsonAccessor<Remainder> : [
    {
        type: "field";
        name: Name;
    },
    Remainder
]) extends infer Parsed ? Parsed extends [
    infer Field,
    `${infer Remainder}`
] ? (Remainder extends `::${infer _}` ? ParseFieldTypeCast<Remainder> extends [
    infer CastType,
    `${infer Remainder}`
] ? [
    Omit<Field, "castType"> & {
        castType: CastType;
    },
    Remainder
] : ParseFieldTypeCast<Remainder> : [
    Field,
    Remainder
]) extends infer Parsed ? Parsed extends [
    infer Field,
    `${infer Remainder}`
] ? Remainder extends `.${infer _}` ? ParseFieldAggregation<Remainder> extends [
    infer AggregateFunction,
    `${infer Remainder}`
] ? Remainder extends `::${infer _}` ? ParseFieldTypeCast<Remainder> extends [
    infer CastType,
    `${infer Remainder}`
] ? [
    Omit<Field, "castType"> & {
        aggregateFunction: AggregateFunction;
        castType: CastType;
    },
    Remainder
] : ParseFieldTypeCast<Remainder> : [
    Field & {
        aggregateFunction: AggregateFunction;
    },
    Remainder
] : ParseFieldAggregation<Remainder> : [
    Field,
    Remainder
] : Parsed : never : Parsed : never : ParserError<`Expected identifier at \`${Input}\``>;
type ParseJsonAccessor<Input extends string> = Input extends `->${infer Remainder}` ? Remainder extends `>${infer Remainder}` ? ParseIdentifier<Remainder> extends [
    infer Name,
    `${infer Remainder}`
] ? [
    Name,
    "text",
    EatWhitespace<Remainder>
] : ParserError<"Expected property name after `->>`"> : ParseIdentifier<Remainder> extends [
    infer Name,
    `${infer Remainder}`
] ? ParseJsonAccessor<Remainder> extends [
    infer PropertyName,
    infer PropertyType,
    `${infer Remainder}`
] ? [
    PropertyName,
    PropertyType,
    EatWhitespace<Remainder>
] : [
    Name,
    "json",
    EatWhitespace<Remainder>
] : ParserError<"Expected property name after `->`"> : ParserError<"Expected ->">;
type ParseFieldTypeCast<Input extends string> = EatWhitespace<Input> extends `::${infer Remainder}` ? ParseIdentifier<EatWhitespace<Remainder>> extends [
    `${infer CastType}`,
    `${infer Remainder}`
] ? [
    CastType,
    EatWhitespace<Remainder>
] : ParserError<`Invalid type for \`::\` operator at \`${Remainder}\``> : ParserError<"Expected ::">;
type ParseFieldAggregation<Input extends string> = EatWhitespace<Input> extends `.${infer Remainder}` ? ParseIdentifier<EatWhitespace<Remainder>> extends [
    `${infer FunctionName}`,
    `${infer Remainder}`
] ? FunctionName extends Token.AggregateFunction ? EatWhitespace<Remainder> extends `()${infer Remainder}` ? [
    FunctionName,
    EatWhitespace<Remainder>
] : ParserError<`Expected \`()\` after \`.\` operator \`${FunctionName}\``> : ParserError<`Invalid type for \`.\` operator \`${FunctionName}\``> : ParserError<`Invalid type for \`.\` operator at \`${Remainder}\``> : ParserError<"Expected .">;
type ParseIdentifier<Input extends string> = ParseLetters<Input> extends [
    infer Name,
    `${infer Remainder}`
] ? [
    Name,
    EatWhitespace<Remainder>
] : ParseQuotedLetters<Input> extends [
    infer Name,
    `${infer Remainder}`
] ? [
    Name,
    EatWhitespace<Remainder>
] : ParserError<`No (possibly double-quoted) identifier at \`${Input}\``>;
type ParseLetters<Input extends string> = string extends Input ? GenericStringError : ParseLettersHelper<Input, ""> extends [
    `${infer Letters}`,
    `${infer Remainder}`
] ? Letters extends "" ? ParserError<`Expected letter at \`${Input}\``> : [
    Letters,
    Remainder
] : ParseLettersHelper<Input, "">;
type ParseLettersHelper<Input extends string, Acc extends string> = string extends Input ? GenericStringError : Input extends `${infer L}${infer Remainder}` ? L extends Token.Letter ? ParseLettersHelper<Remainder, `${Acc}${L}`> : [
    Acc,
    Input
] : [
    Acc,
    ""
];
type ParseQuotedLetters<Input extends string> = string extends Input ? GenericStringError : Input extends `"${infer Remainder}` ? ParseQuotedLettersHelper<Remainder, ""> extends [
    `${infer Letters}`,
    `${infer Remainder}`
] ? Letters extends "" ? ParserError<`Expected string at \`${Remainder}\``> : [
    Letters,
    Remainder
] : ParseQuotedLettersHelper<Remainder, ""> : ParserError<`Not a double-quoted string at \`${Input}\``>;
type ParseQuotedLettersHelper<Input extends string, Acc extends string> = string extends Input ? GenericStringError : Input extends `${infer L}${infer Remainder}` ? L extends "\"" ? [
    Acc,
    Remainder
] : ParseQuotedLettersHelper<Remainder, `${Acc}${L}`> : ParserError<`Missing closing double-quote in \`"${Acc}${Input}\``>;
type EatWhitespace<Input extends string> = string extends Input ? GenericStringError : Input extends `${Token.Whitespace}${infer Remainder}` ? EatWhitespace<Remainder> : Input;
type CreateParserErrorIfRequired<Input, Message extends string> = Input extends ParserError<string> ? Input : ParserError<Message>;
type ParserError<Message extends string> = {
    error: true;
} & Message;
type GenericStringError = ParserError<"Received a generic string">;
declare namespace Ast {
    type Node = FieldNode | StarNode | SpreadNode;
    type FieldNode = {
        type: "field";
        name: string;
        alias?: string;
        hint?: string;
        innerJoin?: true;
        castType?: string;
        jsonPath?: string;
        aggregateFunction?: Token.AggregateFunction;
        children?: Node[];
    };
    type StarNode = {
        type: "star";
    };
    type SpreadNode = {
        type: "spread";
        target: FieldNode & {
            children: Node[];
        };
    };
}
declare namespace Token {
    export type Whitespace = " " | "\n" | "\t";
    type LowerAlphabet = "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h" | "i" | "j" | "k" | "l" | "m" | "n" | "o" | "p" | "q" | "r" | "s" | "t" | "u" | "v" | "w" | "x" | "y" | "z";
    type Alphabet = LowerAlphabet | Uppercase<LowerAlphabet>;
    type Digit = "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "0";
    export type Letter = Alphabet | Digit | "_";
    export type AggregateFunction = "count" | "sum" | "avg" | "min" | "max";
    export {};
}
type IsAny<T> = 0 extends 1 & T ? true : false;
type SelectQueryError<Message extends string> = {
    error: true;
} & Message;
type DeduplicateRelationships<T extends readonly unknown[]> = T extends readonly [
    infer First,
    ...infer Rest
] ? First extends Rest[number] ? DeduplicateRelationships<Rest extends readonly unknown[] ? Rest : [
]> : [
    First,
    ...DeduplicateRelationships<Rest extends readonly unknown[] ? Rest : [
    ]>
] : T;
type GetFieldNodeResultName<Field extends Ast.FieldNode> = Field["alias"] extends string ? Field["alias"] : Field["aggregateFunction"] extends AggregateFunctions ? Field["aggregateFunction"] : Field["name"];
type FilterRelationNodes<Nodes extends Ast.Node[]> = UnionToArray<{
    [K in keyof Nodes]: Nodes[K] extends Ast.SpreadNode ? Nodes[K]["target"] : Nodes[K] extends Ast.FieldNode ? IsNonEmptyArray<Nodes[K]["children"]> extends true ? Nodes[K] : never : never;
}[number]>;
type ResolveRelationships<Schema extends GenericSchema, RelationName extends string, Relationships extends GenericRelationship[], Nodes extends Ast.FieldNode[]> = UnionToArray<{
    [K in keyof Nodes]: Nodes[K] extends Ast.FieldNode ? ResolveRelationship<Schema, Relationships, Nodes[K], RelationName> extends infer Relation ? Relation extends {
        relation: {
            referencedRelation: string;
            foreignKeyName: string;
            match: string;
        };
        from: string;
    } ? {
        referencedTable: Relation["relation"]["referencedRelation"];
        fkName: Relation["relation"]["foreignKeyName"];
        from: Relation["from"];
        match: Relation["relation"]["match"];
        fieldName: GetFieldNodeResultName<Nodes[K]>;
    } : Relation : never : never;
}>[0];
type IsDoubleReference<T, U> = T extends {
    referencedTable: infer RT;
    fieldName: infer FN;
    match: infer M;
} ? M extends "col" | "refrel" ? U extends {
    referencedTable: RT;
    fieldName: FN;
    match: M;
} ? true : false : false : false;
type CheckDuplicates<Arr extends any[], Current> = Arr extends [
    infer Head,
    ...infer Tail
] ? IsDoubleReference<Current, Head> extends true ? Head | CheckDuplicates<Tail, Current> : CheckDuplicates<Tail, Current> : never;
type FindDuplicatesWithinDeduplicated<Arr extends any[]> = Arr extends [
    infer Head,
    ...infer Tail
] ? CheckDuplicates<Tail, Head> | FindDuplicatesWithinDeduplicated<Tail> : never;
type FindDuplicates<Arr extends any[]> = FindDuplicatesWithinDeduplicated<DeduplicateRelationships<Arr>>;
type CheckDuplicateEmbededReference<Schema extends GenericSchema, RelationName extends string, Relationships extends GenericRelationship[], Nodes extends Ast.Node[]> = FilterRelationNodes<Nodes> extends infer RelationsNodes ? RelationsNodes extends Ast.FieldNode[] ? ResolveRelationships<Schema, RelationName, Relationships, RelationsNodes> extends infer ResolvedRels ? ResolvedRels extends unknown[] ? FindDuplicates<ResolvedRels> extends infer Duplicates ? Duplicates extends never ? false : Duplicates extends {
    fieldName: infer FieldName;
} ? FieldName extends string ? {
    [K in FieldName]: SelectQueryError<`table "${RelationName}" specified more than once use hinting for desambiguation`>;
} : false : false : false : false : false : false : false;
type HasFKeyToFRel<FRelName, Relationships> = Relationships extends [
    infer R
] ? R extends {
    referencedRelation: FRelName;
} ? true : false : Relationships extends [
    infer R,
    ...infer Rest
] ? HasFKeyToFRel<FRelName, [
    R
]> extends true ? true : HasFKeyToFRel<FRelName, Rest> : false;
type HasMultipleFKeysToFRelDeduplicated<FRelName, Relationships> = Relationships extends [
    infer R,
    ...infer Rest
] ? R extends {
    referencedRelation: FRelName;
} ? HasFKeyToFRel<FRelName, Rest> extends true ? true : HasMultipleFKeysToFRelDeduplicated<FRelName, Rest> : HasMultipleFKeysToFRelDeduplicated<FRelName, Rest> : false;
type HasMultipleFKeysToFRel<FRelName, Relationships extends unknown[]> = HasMultipleFKeysToFRelDeduplicated<FRelName, DeduplicateRelationships<Relationships>>;
type CheckRelationshipError<Schema extends GenericSchema, Relationships extends GenericRelationship[], CurrentTableOrView extends keyof TablesAndViews<Schema> & string, FoundRelation> = FoundRelation extends SelectQueryError<string> ? FoundRelation : FoundRelation extends {
    relation: {
        referencedRelation: infer RelatedRelationName;
        name: string;
    };
    direction: "reverse";
} ? RelatedRelationName extends string ? HasMultipleFKeysToFRel<RelatedRelationName, Relationships> extends true ? SelectQueryError<`Could not embed because more than one relationship was found for '${RelatedRelationName}' and '${CurrentTableOrView}' you need to hint the column with ${RelatedRelationName}!<columnName> ?`> : FoundRelation : never : FoundRelation extends {
    relation: {
        referencedRelation: infer RelatedRelationName;
        name: string;
    };
    direction: "forward";
    from: infer From;
} ? RelatedRelationName extends string ? From extends keyof TablesAndViews<Schema> & string ? HasMultipleFKeysToFRel<RelatedRelationName, TablesAndViews<Schema>[From]["Relationships"]> extends true ? SelectQueryError<`Could not embed because more than one relationship was found for '${From}' and '${RelatedRelationName}' you need to hint the column with ${From}!<columnName> ?`> : FoundRelation : never : never : FoundRelation;
type ResolveRelationship<Schema extends GenericSchema, Relationships extends GenericRelationship[], Field extends Ast.FieldNode, CurrentTableOrView extends keyof TablesAndViews<Schema> & string> = ResolveReverseRelationship<Schema, Relationships, Field, CurrentTableOrView> extends infer ReverseRelationship ? ReverseRelationship extends false ? CheckRelationshipError<Schema, Relationships, CurrentTableOrView, ResolveForwardRelationship<Schema, Field, CurrentTableOrView>> : CheckRelationshipError<Schema, Relationships, CurrentTableOrView, ReverseRelationship> : never;
type ResolveReverseRelationship<Schema extends GenericSchema, Relationships extends GenericRelationship[], Field extends Ast.FieldNode, CurrentTableOrView extends keyof TablesAndViews<Schema> & string> = FindFieldMatchingRelationships<Schema, Relationships, Field> extends infer FoundRelation ? FoundRelation extends never ? false : FoundRelation extends {
    referencedRelation: infer RelatedRelationName;
} ? RelatedRelationName extends string ? RelatedRelationName extends keyof TablesAndViews<Schema> ? FoundRelation extends {
    hint: string;
} ? {
    referencedTable: TablesAndViews<Schema>[RelatedRelationName];
    relation: FoundRelation;
    direction: "reverse";
    from: CurrentTableOrView;
} : HasMultipleFKeysToFRel<RelatedRelationName, Relationships> extends true ? SelectQueryError<`Could not embed because more than one relationship was found for '${RelatedRelationName}' and '${CurrentTableOrView}' you need to hint the column with ${RelatedRelationName}!<columnName> ?`> : {
    referencedTable: TablesAndViews<Schema>[RelatedRelationName];
    relation: FoundRelation;
    direction: "reverse";
    from: CurrentTableOrView;
} : SelectQueryError<`Relation '${RelatedRelationName}' not found in schema.`> : false : false : false;
type FindMatchingTableRelationships<Schema extends GenericSchema, Relationships extends GenericRelationship[], value extends string> = Relationships extends [
    infer R,
    ...infer Rest
] ? Rest extends GenericRelationship[] ? R extends {
    referencedRelation: infer ReferencedRelation;
} ? ReferencedRelation extends keyof Schema["Tables"] ? R extends {
    foreignKeyName: value;
} ? R & {
    match: "fkname";
} : R extends {
    referencedRelation: value;
} ? R & {
    match: "refrel";
} : R extends {
    columns: [
        value
    ];
} ? R & {
    match: "col";
} : FindMatchingTableRelationships<Schema, Rest, value> : FindMatchingTableRelationships<Schema, Rest, value> : false : false : false;
type FindMatchingViewRelationships<Schema extends GenericSchema, Relationships extends GenericRelationship[], value extends string> = Relationships extends [
    infer R,
    ...infer Rest
] ? Rest extends GenericRelationship[] ? R extends {
    referencedRelation: infer ReferencedRelation;
} ? ReferencedRelation extends keyof Schema["Views"] ? R extends {
    foreignKeyName: value;
} ? R & {
    match: "fkname";
} : R extends {
    referencedRelation: value;
} ? R & {
    match: "refrel";
} : R extends {
    columns: [
        value
    ];
} ? R & {
    match: "col";
} : FindMatchingViewRelationships<Schema, Rest, value> : FindMatchingViewRelationships<Schema, Rest, value> : false : false : false;
type FindMatchingHintTableRelationships<Schema extends GenericSchema, Relationships extends GenericRelationship[], hint extends string, name extends string> = Relationships extends [
    infer R,
    ...infer Rest
] ? Rest extends GenericRelationship[] ? R extends {
    referencedRelation: infer ReferencedRelation;
} ? ReferencedRelation extends name ? R extends {
    foreignKeyName: hint;
} ? R & {
    match: "fkname";
} : R extends {
    referencedRelation: hint;
} ? R & {
    match: "refrel";
} : R extends {
    columns: [
        hint
    ];
} ? R & {
    match: "col";
} : FindMatchingHintTableRelationships<Schema, Rest, hint, name> : FindMatchingHintTableRelationships<Schema, Rest, hint, name> : false : false : false;
type FindMatchingHintViewRelationships<Schema extends GenericSchema, Relationships extends GenericRelationship[], hint extends string, name extends string> = Relationships extends [
    infer R,
    ...infer Rest
] ? Rest extends GenericRelationship[] ? R extends {
    referencedRelation: infer ReferencedRelation;
} ? ReferencedRelation extends name ? R extends {
    foreignKeyName: hint;
} ? R & {
    match: "fkname";
} : R extends {
    referencedRelation: hint;
} ? R & {
    match: "refrel";
} : R extends {
    columns: [
        hint
    ];
} ? R & {
    match: "col";
} : FindMatchingHintViewRelationships<Schema, Rest, hint, name> : FindMatchingHintViewRelationships<Schema, Rest, hint, name> : false : false : false;
type IsColumnsNullable<Table extends Pick<GenericTable, "Row">, Columns extends (keyof Table["Row"])[]> = Columns extends [
    infer Column,
    ...infer Rest
] ? Column extends keyof Table["Row"] ? ContainsNull<Table["Row"][Column]> extends true ? true : IsColumnsNullable<Table, Rest extends (keyof Table["Row"])[] ? Rest : [
]> : false : false;
type IsRelationNullable<Table extends GenericTable, Relation extends GenericRelationship> = IsColumnsNullable<Table, Relation["columns"]>;
type TableForwardRelationships<Schema extends GenericSchema, TName> = TName extends keyof TablesAndViews<Schema> ? UnionToArray<RecursivelyFindRelationships<Schema, TName, keyof TablesAndViews<Schema>>> extends infer R ? R extends (GenericRelationship & {
    from: keyof TablesAndViews<Schema>;
})[] ? R : [
] : [
] : [
];
type RecursivelyFindRelationships<Schema extends GenericSchema, TName, Keys extends keyof TablesAndViews<Schema>> = Keys extends infer K ? K extends keyof TablesAndViews<Schema> ? FilterRelationships<TablesAndViews<Schema>[K]["Relationships"], TName, K> extends never ? RecursivelyFindRelationships<Schema, TName, Exclude<Keys, K>> : FilterRelationships<TablesAndViews<Schema>[K]["Relationships"], TName, K> | RecursivelyFindRelationships<Schema, TName, Exclude<Keys, K>> : false : false;
type FilterRelationships<R, TName, From> = R extends readonly (infer Rel)[] ? Rel extends {
    referencedRelation: TName;
} ? Rel & {
    from: From;
} : never : never;
type ResolveForwardRelationship<Schema extends GenericSchema, Field extends Ast.FieldNode, CurrentTableOrView extends keyof TablesAndViews<Schema> & string> = FindFieldMatchingRelationships<Schema, TablesAndViews<Schema>[Field["name"]]["Relationships"], Ast.FieldNode & {
    name: CurrentTableOrView;
    hint: Field["hint"];
}> extends infer FoundByName ? FoundByName extends GenericRelationship ? {
    referencedTable: TablesAndViews<Schema>[Field["name"]];
    relation: FoundByName;
    direction: "forward";
    from: Field["name"];
    type: "found-by-name";
} : FindFieldMatchingRelationships<Schema, TableForwardRelationships<Schema, CurrentTableOrView>, Field> extends infer FoundByMatch ? FoundByMatch extends GenericRelationship & {
    from: keyof TablesAndViews<Schema>;
} ? {
    referencedTable: TablesAndViews<Schema>[FoundByMatch["from"]];
    relation: FoundByMatch;
    direction: "forward";
    from: CurrentTableOrView;
    type: "found-by-match";
} : FindJoinTableRelationship<Schema, CurrentTableOrView, Field["name"]> extends infer FoundByJoinTable ? FoundByJoinTable extends GenericRelationship ? {
    referencedTable: TablesAndViews<Schema>[FoundByJoinTable["referencedRelation"]];
    relation: FoundByJoinTable & {
        match: "refrel";
    };
    direction: "forward";
    from: CurrentTableOrView;
    type: "found-by-join-table";
} : ResolveEmbededFunctionJoinTableRelationship<Schema, CurrentTableOrView, Field["name"]> extends infer FoundEmbededFunctionJoinTableRelation ? FoundEmbededFunctionJoinTableRelation extends GenericFunction ? FoundEmbededFunctionJoinTableRelation["SetofOptions"] extends GenericSetofOption ? FoundEmbededFunctionJoinTableRelation["SetofOptions"]["to"] extends "" ? {
    referencedTable: {
        Row: Record<string, never>;
        Relationships: [
        ];
    };
    relation: {
        foreignKeyName: `${Field["name"]}_${CurrentTableOrView}_scalar_forward`;
        columns: [
        ];
        isOneToOne: false;
        referencedColumns: [
        ];
        referencedRelation: "";
    } & {
        match: "func";
        isNotNullable: FoundEmbededFunctionJoinTableRelation["SetofOptions"]["isNotNullable"] extends true ? true : FoundEmbededFunctionJoinTableRelation["SetofOptions"]["isSetofReturn"] extends true ? false : true;
        isSetofReturn: FoundEmbededFunctionJoinTableRelation["SetofOptions"]["isSetofReturn"];
    };
    scalarType: FoundEmbededFunctionJoinTableRelation["Returns"];
    direction: "forward";
    from: CurrentTableOrView;
    type: "found-by-embeded-scalar-function";
} : {
    referencedTable: TablesAndViews<Schema>[FoundEmbededFunctionJoinTableRelation["SetofOptions"]["to"]];
    relation: {
        foreignKeyName: `${Field["name"]}_${CurrentTableOrView}_${FoundEmbededFunctionJoinTableRelation["SetofOptions"]["to"]}_forward`;
        columns: [
        ];
        isOneToOne: FoundEmbededFunctionJoinTableRelation["SetofOptions"]["isOneToOne"] extends true ? true : false;
        referencedColumns: [
        ];
        referencedRelation: FoundEmbededFunctionJoinTableRelation["SetofOptions"]["to"];
    } & {
        match: "func";
        isNotNullable: FoundEmbededFunctionJoinTableRelation["SetofOptions"]["isNotNullable"] extends true ? true : FoundEmbededFunctionJoinTableRelation["SetofOptions"]["isSetofReturn"] extends true ? false : true;
        isSetofReturn: FoundEmbededFunctionJoinTableRelation["SetofOptions"]["isSetofReturn"];
    };
    direction: "forward";
    from: CurrentTableOrView;
    type: "found-by-embeded-function";
} : SelectQueryError<`could not find the relation between ${CurrentTableOrView} and ${Field["name"]}`> : SelectQueryError<`could not find the relation between ${CurrentTableOrView} and ${Field["name"]}`> : SelectQueryError<`could not find the relation between ${CurrentTableOrView} and ${Field["name"]}`> : SelectQueryError<`could not find the relation between ${CurrentTableOrView} and ${Field["name"]}`> : SelectQueryError<`could not find the relation between ${CurrentTableOrView} and ${Field["name"]}`> : SelectQueryError<`could not find the relation between ${CurrentTableOrView} and ${Field["name"]}`>;
type ResolveJoinTableRelationship<Schema extends GenericSchema, CurrentTableOrView extends keyof TablesAndViews<Schema> & string, FieldName extends string> = {
    [TableName in keyof TablesAndViews<Schema>]: DeduplicateRelationships<TablesAndViews<Schema>[TableName]["Relationships"]> extends readonly (infer Rel)[] ? Rel extends {
        referencedRelation: CurrentTableOrView;
    } ? DeduplicateRelationships<TablesAndViews<Schema>[TableName]["Relationships"]> extends readonly (infer OtherRel)[] ? OtherRel extends {
        referencedRelation: FieldName;
    } ? OtherRel : never : never : never : never;
}[keyof TablesAndViews<Schema>];
type ResolveEmbededFunctionJoinTableRelationship<Schema extends GenericSchema, CurrentTableOrView extends keyof TablesAndViews<Schema> & string, FieldName extends string> = FindMatchingFunctionBySetofFrom<Schema["Functions"][FieldName], CurrentTableOrView> extends infer Fn ? Fn extends GenericFunction ? Fn : false : false;
type FindJoinTableRelationship<Schema extends GenericSchema, CurrentTableOrView extends keyof TablesAndViews<Schema> & string, FieldName extends string> = ResolveJoinTableRelationship<Schema, CurrentTableOrView, FieldName> extends infer Result ? [
    Result
] extends [
    never
] ? false : Result : never;
type FindFieldMatchingRelationships<Schema extends GenericSchema, Relationships extends GenericRelationship[], Field extends Ast.FieldNode> = Field extends {
    hint: string;
} ? FindMatchingHintTableRelationships<Schema, Relationships, Field["hint"], Field["name"]> extends GenericRelationship ? FindMatchingHintTableRelationships<Schema, Relationships, Field["hint"], Field["name"]> & {
    branch: "found-in-table-via-hint";
    hint: Field["hint"];
} : FindMatchingHintViewRelationships<Schema, Relationships, Field["hint"], Field["name"]> extends GenericRelationship ? FindMatchingHintViewRelationships<Schema, Relationships, Field["hint"], Field["name"]> & {
    branch: "found-in-view-via-hint";
    hint: Field["hint"];
} : SelectQueryError<"Failed to find matching relation via hint"> : FindMatchingTableRelationships<Schema, Relationships, Field["name"]> extends GenericRelationship ? FindMatchingTableRelationships<Schema, Relationships, Field["name"]> & {
    branch: "found-in-table-via-name";
    name: Field["name"];
} : FindMatchingViewRelationships<Schema, Relationships, Field["name"]> extends GenericRelationship ? FindMatchingViewRelationships<Schema, Relationships, Field["name"]> & {
    branch: "found-in-view-via-name";
    name: Field["name"];
} : SelectQueryError<"Failed to find matching relation via name">;
type JsonPathToAccessor<Path extends string> = Path extends `${infer P1}->${infer P2}` ? P2 extends `>${infer Rest}` ? JsonPathToAccessor<`${P1}.${Rest}`> : P2 extends string ? JsonPathToAccessor<`${P1}.${P2}`> : Path : Path extends `>${infer Rest}` ? JsonPathToAccessor<Rest> : Path extends `${infer P1}::${infer _}` ? JsonPathToAccessor<P1> : Path extends `${infer P1}${")" | ","}${infer _}` ? P1 : Path;
type JsonPathToType<T, Path extends string> = Path extends "" ? T : ContainsNull<T> extends true ? JsonPathToType<Exclude<T, null>, Path> : Path extends `${infer Key}.${infer Rest}` ? Key extends keyof T ? JsonPathToType<T[Key], Rest> : never : Path extends keyof T ? T[Path] : never;
type IsStringUnion<T> = string extends T ? false : T extends string ? [
    T
] extends [
    never
] ? false : true : false;
type MatchingFunctionBySetofFrom<Fn extends GenericFunction, TableName extends string> = Fn["SetofOptions"] extends GenericSetofOption ? TableName extends Fn["SetofOptions"]["from"] ? Fn : never : false;
type FindMatchingFunctionBySetofFrom<FnUnion, TableName extends string> = FnUnion extends infer Fn extends GenericFunction ? MatchingFunctionBySetofFrom<Fn, TableName> : false;
type ComputedField<Schema extends GenericSchema, RelationName extends keyof TablesAndViews<Schema>, FieldName extends keyof TablesAndViews<Schema>[RelationName]["Row"]> = FieldName extends keyof Schema["Functions"] ? [
    Schema["Functions"][FieldName]["Args"]
] extends [
    never
] ? never : Schema["Functions"][FieldName] extends {
    Args: {
        "": TablesAndViews<Schema>[RelationName]["Row"];
    };
    Returns: any;
} ? FieldName : never : never;
type GetComputedFields<Schema extends GenericSchema, RelationName extends keyof TablesAndViews<Schema>> = {
    [K in keyof TablesAndViews<Schema>[RelationName]["Row"]]: ComputedField<Schema, RelationName, K>;
}[keyof TablesAndViews<Schema>[RelationName]["Row"]];
interface PostgrestResponseBase {
    status: number;
    statusText: string;
}
interface PostgrestResponseSuccess<T> extends PostgrestResponseBase {
    success: true;
    error: null;
    data: T;
    count: number | null;
}
interface PostgrestResponseFailure extends PostgrestResponseBase {
    success: false;
    error: PostgrestError;
    data: null;
    count: null;
}
export type PostgrestSingleResponse<T> = PostgrestResponseSuccess<T> | PostgrestResponseFailure;
export type PostgrestMaybeSingleResponse<T> = PostgrestSingleResponse<T | null>;
export type PostgrestResponse<T> = PostgrestSingleResponse<T[]>;
type Prettify<T> = {
    [K in keyof T]: T[K];
} & {};
type RejectExcessProperties<Base, Row> = Row & {
    [K in Exclude<keyof Row, keyof Base>]: never;
};
type SimplifyDeep<Type, ExcludeType = never> = ConditionalSimplifyDeep<Type, ExcludeType | NonRecursiveType | Set<unknown> | Map<unknown, unknown>, object>;
type ConditionalSimplifyDeep<Type, ExcludeType = never, IncludeType = unknown> = Type extends ExcludeType ? Type : Type extends IncludeType ? {
    [TypeKey in keyof Type]: ConditionalSimplifyDeep<Type[TypeKey], ExcludeType, IncludeType>;
} : Type;
type NonRecursiveType = BuiltIns | Function | (new (...arguments_: any[]) => unknown);
type BuiltIns = Primitive | void | Date | RegExp;
type Primitive = null | undefined | string | number | boolean | symbol | bigint;
type IsValidResultOverride<Result, NewResult, ErrorResult, ErrorNewResult> = Result extends any[] ? NewResult extends any[] ? true : ErrorResult : NewResult extends any[] ? ErrorNewResult : true;
type CheckMatchingArrayTypes<Result, NewResult> = Result extends SelectQueryError<string> ? NewResult : IsValidResultOverride<Result, NewResult, {
    Error: "Type mismatch: Cannot cast array result to a single object. Use .overrideTypes<Array<YourType>> or .returns<Array<YourType>> (deprecated) for array results or .single() to convert the result to a single object";
}, {
    Error: "Type mismatch: Cannot cast single object to array type. Remove Array wrapper from return type or make sure you are not using .single() up in the calling chain";
}> extends infer ValidationResult ? ValidationResult extends true ? ContainsNull<Result> extends true ? NewResult | null : NewResult : ValidationResult : never;
type Simplify<T> = T extends object ? {
    [K in keyof T]: T[K];
} : T;
type ExplicitKeys<T> = {
    [K in keyof T]: string extends K ? never : K;
}[keyof T];
type MergeExplicit<New, Row> = {
    [K in ExplicitKeys<New> | ExplicitKeys<Row>]: K extends keyof New ? K extends keyof Row ? Row[K] extends SelectQueryError<string> ? New[K] : New[K] extends any[] ? Row[K] extends any[] ? Array<Simplify<MergeDeep<NonNullable<New[K][number]>, NonNullable<Row[K][number]>>>> : New[K] : IsPlainObject<NonNullable<New[K]>> extends true ? IsPlainObject<NonNullable<Row[K]>> extends true ? ContainsNull<New[K]> extends true ? Simplify<MergeDeep<NonNullable<New[K]>, NonNullable<Row[K]>>> | null : Simplify<MergeDeep<New[K], NonNullable<Row[K]>>> : New[K] : New[K] : New[K] : K extends keyof Row ? Row[K] : never;
};
type MergeDeep<New, Row> = Simplify<MergeExplicit<New, Row> & (string extends keyof Row ? {
    [K: string]: Row[string];
} : {})>;
type IsPlainObject<T> = T extends any[] ? false : T extends object ? true : false;
type MergePartialResult<NewResult, Result, Options> = Options extends {
    merge: true;
} ? Result extends any[] ? NewResult extends any[] ? Array<Simplify<MergeDeep<NewResult[number], Result[number]>>> : never : Simplify<MergeDeep<NewResult, Result>> : NewResult;
export declare abstract class PostgrestBuilder<ClientOptions extends ClientServerOptions, Result, ThrowOnError extends boolean = false> implements PromiseLike<ThrowOnError extends true ? PostgrestResponseSuccess<Result> : PostgrestSingleResponse<Result>> {
    protected method: "GET" | "HEAD" | "POST" | "PATCH" | "DELETE";
    protected url: URL;
    protected headers: Headers;
    protected schema?: string;
    protected body?: unknown;
    protected shouldThrowOnError: boolean;
    protected signal?: AbortSignal;
    protected fetch: Fetch;
    protected isMaybeSingle: boolean;
    protected shouldStripNulls: boolean;
    protected urlLengthLimit: number;
    protected retryEnabled: boolean;
    constructor(builder: {
        method: "GET" | "HEAD" | "POST" | "PATCH" | "DELETE";
        url: URL;
        headers: HeadersInit;
        schema?: string;
        body?: unknown;
        shouldThrowOnError?: boolean;
        signal?: AbortSignal;
        fetch?: Fetch;
        isMaybeSingle?: boolean;
        shouldStripNulls?: boolean;
        urlLengthLimit?: number;
        retry?: boolean;
    });
    throwOnError(): PostgrestBuilder<ClientOptions, Result, true>;
    stripNulls(): this;
    setHeader(name: string, value: string): this;
    retry(enabled: boolean): this;
    then<TResult1 = ThrowOnError extends true ? PostgrestResponseSuccess<Result> : PostgrestSingleResponse<Result>, TResult2 = never>(onfulfilled?: ((value: ThrowOnError extends true ? PostgrestResponseSuccess<Result> : PostgrestSingleResponse<Result>) => TResult1 | PromiseLike<TResult1>) | undefined | null, onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null): PromiseLike<TResult1 | TResult2>;
    private processResponse;
    returns<NewResult>(): PostgrestBuilder<ClientOptions, CheckMatchingArrayTypes<Result, NewResult>, ThrowOnError>;
    overrideTypes<NewResult, Options extends {
        merge?: boolean;
    } = {
        merge: true;
    }>(): PostgrestBuilder<ClientOptions, IsValidResultOverride<Result, NewResult, false, false> extends true ? ContainsNull<Result> extends true ? MergePartialResult<NewResult, NonNullable<Result>, Options> | null : MergePartialResult<NewResult, Result, Options> : CheckMatchingArrayTypes<Result, NewResult>, ThrowOnError>;
}
type IsPostgrest13<PostgrestVersion extends string | undefined> = PostgrestVersion extends `13${string}` ? true : false;
type IsPostgrest14<PostgrestVersion extends string | undefined> = PostgrestVersion extends `14${string}` ? true : false;
type IsPostgrestVersionGreaterThan12<PostgrestVersion extends string | undefined> = IsPostgrest13<PostgrestVersion> extends true ? true : IsPostgrest14<PostgrestVersion> extends true ? true : false;
type MaxAffectedEnabled<PostgrestVersion extends string | undefined> = IsPostgrestVersionGreaterThan12<PostgrestVersion> extends true ? true : false;
type SpreadOnManyEnabled<PostgrestVersion extends string | undefined> = IsPostgrestVersionGreaterThan12<PostgrestVersion> extends true ? true : false;
type GetResult<Schema extends GenericSchema, Row extends Record<string, unknown>, RelationName, Relationships, Query extends string, ClientOptions extends ClientServerOptions> = IsAny<Schema> extends true ? ParseQuery<Query> extends infer ParsedQuery ? ParsedQuery extends Ast.Node[] ? RelationName extends string ? ProcessNodesWithoutSchema<ParsedQuery> : any : ParsedQuery : any : Relationships extends null ? ParseQuery<Query> extends infer ParsedQuery ? ParsedQuery extends Ast.Node[] ? RPCCallNodes<ParsedQuery, RelationName extends string ? RelationName : "rpc_call", Row> : ParsedQuery : Row : ParseQuery<Query> extends infer ParsedQuery ? ParsedQuery extends Ast.Node[] ? RelationName extends string ? Relationships extends GenericRelationship[] ? ProcessNodes<ClientOptions, Schema, Row, RelationName, Relationships, ParsedQuery> : SelectQueryError<"Invalid Relationships cannot infer result type"> : SelectQueryError<"Invalid RelationName cannot infer result type"> : ParsedQuery : never;
type ProcessSimpleFieldWithoutSchema<Field extends Ast.FieldNode> = Field["aggregateFunction"] extends AggregateFunctions ? {
    [K in GetFieldNodeResultName<Field>]: Field["castType"] extends PostgreSQLTypes ? TypeScriptTypes<Field["castType"]> : number;
} : {
    [K in GetFieldNodeResultName<Field>]: Field["castType"] extends PostgreSQLTypes ? TypeScriptTypes<Field["castType"]> : any;
};
type ProcessFieldNodeWithoutSchema<Node extends Ast.FieldNode> = IsNonEmptyArray<Node["children"]> extends true ? {
    [K in GetFieldNodeResultName<Node>]: Node["children"] extends Ast.Node[] ? ProcessNodesWithoutSchema<Node["children"]>[] : ProcessSimpleFieldWithoutSchema<Node>;
} : ProcessSimpleFieldWithoutSchema<Node>;
type ProcessNodeWithoutSchema<Node extends Ast.Node> = Node extends Ast.StarNode ? any : Node extends Ast.SpreadNode ? Node["target"]["children"] extends Ast.StarNode[] ? any : Node["target"]["children"] extends Ast.FieldNode[] ? {
    [P in Node["target"]["children"][number] as GetFieldNodeResultName<P>]: P["castType"] extends PostgreSQLTypes ? TypeScriptTypes<P["castType"]> : any;
} : any : Node extends Ast.FieldNode ? ProcessFieldNodeWithoutSchema<Node> : any;
type ProcessNodesWithoutSchema<Nodes extends Ast.Node[], Acc extends Record<string, unknown> = {}> = Nodes extends [
    infer FirstNode,
    ...infer RestNodes
] ? FirstNode extends Ast.Node ? RestNodes extends Ast.Node[] ? ProcessNodeWithoutSchema<FirstNode> extends infer FieldResult ? FieldResult extends Record<string, unknown> ? ProcessNodesWithoutSchema<RestNodes, Acc & FieldResult> : FieldResult : any : any : any : Prettify<Acc>;
type ProcessRPCNode<Row extends Record<string, unknown>, RelationName extends string, NodeType extends Ast.Node> = NodeType["type"] extends Ast.StarNode["type"] ? Row : NodeType["type"] extends Ast.FieldNode["type"] ? ProcessSimpleField<Row, RelationName, Extract<NodeType, Ast.FieldNode>> : SelectQueryError<"RPC Unsupported node type.">;
type RPCCallNodes<Nodes extends Ast.Node[], RelationName extends string, Row extends Record<string, unknown>, Acc extends Record<string, unknown> = {}> = Nodes extends [
    infer FirstNode,
    ...infer RestNodes
] ? FirstNode extends Ast.Node ? RestNodes extends Ast.Node[] ? ProcessRPCNode<Row, RelationName, FirstNode> extends infer FieldResult ? FieldResult extends Record<string, unknown> ? RPCCallNodes<RestNodes, RelationName, Row, Acc & FieldResult> : FieldResult extends SelectQueryError<infer E> ? SelectQueryError<E> : SelectQueryError<"Could not retrieve a valid record or error value"> : SelectQueryError<"Processing node failed."> : SelectQueryError<"Invalid rest nodes array in RPC call"> : SelectQueryError<"Invalid first node in RPC call"> : Prettify<Acc>;
type ProcessNodes<ClientOptions extends ClientServerOptions, Schema extends GenericSchema, Row extends Record<string, unknown>, RelationName extends string, Relationships extends GenericRelationship[], Nodes extends Ast.Node[], Acc extends Record<string, unknown> = {}> = CheckDuplicateEmbededReference<Schema, RelationName, Relationships, Nodes> extends false ? Nodes extends [
    infer FirstNode,
    ...infer RestNodes
] ? FirstNode extends Ast.Node ? RestNodes extends Ast.Node[] ? ProcessNode<ClientOptions, Schema, Row, RelationName, Relationships, FirstNode> extends infer FieldResult ? FieldResult extends Record<string, unknown> ? ProcessNodes<ClientOptions, Schema, Row, RelationName, Relationships, RestNodes, Acc & FieldResult> : FieldResult extends SelectQueryError<infer E> ? SelectQueryError<E> : SelectQueryError<"Could not retrieve a valid record or error value"> : SelectQueryError<"Processing node failed."> : SelectQueryError<"Invalid rest nodes array type in ProcessNodes"> : SelectQueryError<"Invalid first node type in ProcessNodes"> : Prettify<Acc> : Prettify<CheckDuplicateEmbededReference<Schema, RelationName, Relationships, Nodes>>;
type ProcessNode<ClientOptions extends ClientServerOptions, Schema extends GenericSchema, Row extends Record<string, unknown>, RelationName extends string, Relationships extends GenericRelationship[], NodeType extends Ast.Node> = NodeType["type"] extends Ast.StarNode["type"] ? GetComputedFields<Schema, RelationName> extends never ? Row : Omit<Row, GetComputedFields<Schema, RelationName>> : NodeType["type"] extends Ast.SpreadNode["type"] ? ProcessSpreadNode<ClientOptions, Schema, Row, RelationName, Relationships, Extract<NodeType, Ast.SpreadNode>> : NodeType["type"] extends Ast.FieldNode["type"] ? ProcessFieldNode<ClientOptions, Schema, Row, RelationName, Relationships, Extract<NodeType, Ast.FieldNode>> : SelectQueryError<"Unsupported node type.">;
type ProcessFieldNode<ClientOptions extends ClientServerOptions, Schema extends GenericSchema, Row extends Record<string, unknown>, RelationName extends string, Relationships extends GenericRelationship[], Field extends Ast.FieldNode> = Field["children"] extends [
] ? ProcessEmbeddedResource<ClientOptions, Schema, Relationships, Field, RelationName> : IsNonEmptyArray<Field["children"]> extends true ? ProcessEmbeddedResource<ClientOptions, Schema, Relationships, Field, RelationName> : ProcessSimpleField<Row, RelationName, Field>;
type ResolveJsonPathType<Value, Path extends string | undefined, CastType extends PostgreSQLTypes> = Path extends string ? JsonPathToType<Value, Path> extends never ? TypeScriptTypes<CastType> : JsonPathToType<Value, Path> extends infer PathResult ? PathResult extends string ? PathResult : IsStringUnion<PathResult> extends true ? PathResult : CastType extends "json" ? PathResult : TypeScriptTypes<CastType> : TypeScriptTypes<CastType> : TypeScriptTypes<CastType>;
type ProcessSimpleField<Row extends Record<string, unknown>, RelationName extends string, Field extends Ast.FieldNode> = Field["name"] extends keyof Row | "count" ? Field["aggregateFunction"] extends AggregateFunctions ? {
    [K in GetFieldNodeResultName<Field>]: Field["castType"] extends PostgreSQLTypes ? TypeScriptTypes<Field["castType"]> : number;
} : {
    [K in GetFieldNodeResultName<Field>]: Field["castType"] extends PostgreSQLTypes ? ResolveJsonPathType<Row[Field["name"]], Field["jsonPath"], Field["castType"]> : Row[Field["name"]];
} : SelectQueryError<`column '${Field["name"]}' does not exist on '${RelationName}'.`>;
type ProcessEmbeddedResource<ClientOptions extends ClientServerOptions, Schema extends GenericSchema, Relationships extends GenericRelationship[], Field extends Ast.FieldNode, CurrentTableOrView extends keyof TablesAndViews<Schema> & string> = ResolveRelationship<Schema, Relationships, Field, CurrentTableOrView> extends infer Resolved ? Resolved extends {
    scalarType: infer ScalarType;
    relation: {
        isSetofReturn?: boolean;
        isNotNullable?: boolean;
    };
} ? {
    [K in GetFieldNodeResultName<Field>]: Resolved["relation"]["isSetofReturn"] extends true ? ScalarType : Resolved["relation"]["isNotNullable"] extends true ? ScalarType : ScalarType | null;
} : Resolved extends {
    referencedTable: Pick<GenericTable, "Row" | "Relationships">;
    relation: GenericRelationship & {
        match: "refrel" | "col" | "fkname" | "func";
    };
    direction: string;
} ? Field["children"] extends [
] ? {} : ProcessEmbeddedResourceResult<ClientOptions, Schema, Resolved, Field, CurrentTableOrView> : {
    [K in GetFieldNodeResultName<Field>]: Resolved;
} : {
    [K in GetFieldNodeResultName<Field>]: SelectQueryError<"Failed to resolve relationship."> & string;
};
type ProcessEmbeddedResourceResult<ClientOptions extends ClientServerOptions, Schema extends GenericSchema, Resolved extends {
    referencedTable: Pick<GenericTable, "Row" | "Relationships">;
    relation: GenericRelationship & {
        match: "refrel" | "col" | "fkname" | "func";
        isNotNullable?: boolean;
        referencedRelation: string;
        isSetofReturn?: boolean;
    };
    direction: string;
}, Field extends Ast.FieldNode, CurrentTableOrView extends keyof TablesAndViews<Schema>> = ProcessNodes<ClientOptions, Schema, Resolved["referencedTable"]["Row"], Resolved["relation"]["match"] extends "func" ? Resolved["relation"]["referencedRelation"] : Field["name"], Resolved["referencedTable"]["Relationships"], Field["children"] extends undefined ? [
] : Exclude<Field["children"], undefined> extends Ast.Node[] ? Exclude<Field["children"], undefined> : [
]> extends infer ProcessedChildren ? {
    [K in GetFieldNodeResultName<Field>]: Resolved["direction"] extends "forward" ? Field extends {
        innerJoin: true;
    } ? Resolved["relation"]["isOneToOne"] extends true ? ProcessedChildren : ProcessedChildren[] : Resolved["relation"]["isOneToOne"] extends true ? Resolved["relation"]["match"] extends "func" ? Resolved["relation"]["isNotNullable"] extends true ? Resolved["relation"]["isSetofReturn"] extends true ? ProcessedChildren : {
        [P in keyof ProcessedChildren]: ProcessedChildren[P] | null;
    } : ProcessedChildren | null : ProcessedChildren | null : ProcessedChildren[] : Resolved["relation"]["referencedRelation"] extends CurrentTableOrView ? Resolved["relation"]["match"] extends "col" ? IsRelationNullable<TablesAndViews<Schema>[CurrentTableOrView], Resolved["relation"]> extends true ? ProcessedChildren | null : ProcessedChildren : ProcessedChildren[] : IsRelationNullable<TablesAndViews<Schema>[CurrentTableOrView], Resolved["relation"]> extends true ? Field extends {
        innerJoin: true;
    } ? ProcessedChildren : ProcessedChildren | null : ProcessedChildren;
} : {
    [K in GetFieldNodeResultName<Field>]: SelectQueryError<"Failed to process embedded resource nodes."> & string;
};
type ProcessSpreadNode<ClientOptions extends ClientServerOptions, Schema extends GenericSchema, Row extends Record<string, unknown>, RelationName extends string, Relationships extends GenericRelationship[], Spread extends Ast.SpreadNode> = ProcessNode<ClientOptions, Schema, Row, RelationName, Relationships, Spread["target"]> extends infer Result ? Result extends SelectQueryError<infer E> ? SelectQueryError<E> : ExtractFirstProperty<Result> extends unknown[] ? SpreadOnManyEnabled<ClientOptions["PostgrestVersion"]> extends true ? ProcessManyToManySpreadNodeResult<Result> : {
    [K in Spread["target"]["name"]]: SelectQueryError<`"${RelationName}" and "${Spread["target"]["name"]}" do not form a many-to-one or one-to-one relationship spread not possible`>;
} : ProcessSpreadNodeResult<Result> : never;
type ProcessManyToManySpreadNodeResult<Result> = Result extends Record<string, SelectQueryError<string> | null> ? Result : ExtractFirstProperty<Result> extends infer SpreadedObject ? SpreadedObject extends Array<Record<string, unknown>> ? {
    [K in keyof SpreadedObject[number]]: Array<SpreadedObject[number][K]>;
} : SelectQueryError<"An error occurred spreading the many-to-many object"> : SelectQueryError<"An error occurred spreading the many-to-many object">;
type ProcessSpreadNodeResult<Result> = Result extends Record<string, SelectQueryError<string> | null> ? Result : ExtractFirstProperty<Result> extends infer SpreadedObject ? ContainsNull<SpreadedObject> extends true ? Exclude<{
    [K in keyof SpreadedObject]: SpreadedObject[K] | null;
}, null> : Exclude<{
    [K in keyof SpreadedObject]: SpreadedObject[K];
}, null> : SelectQueryError<"An error occurred spreading the object">;
export declare class PostgrestTransformBuilder<ClientOptions extends ClientServerOptions, Schema extends GenericSchema, Row extends Record<string, unknown>, Result, RelationName = unknown, Relationships = unknown, Method = unknown, ThrowOnError extends boolean = false> extends PostgrestBuilder<ClientOptions, Result, ThrowOnError> {
    throwOnError(): PostgrestTransformBuilder<ClientOptions, Schema, Row, Result, RelationName, Relationships, Method, true>;
    select<Query extends string = "*", NewResultOne = GetResult<Schema, Row, RelationName, Relationships, Query, ClientOptions>>(columns?: Query): PostgrestFilterBuilder<ClientOptions, Schema, Row, Method extends "RPC" ? Result extends unknown[] ? NewResultOne[] : NewResultOne : NewResultOne[], RelationName, Relationships, Method, ThrowOnError>;
    order<ColumnName extends string & keyof Row>(column: ColumnName, options?: {
        ascending?: boolean;
        nullsFirst?: boolean;
        referencedTable?: undefined;
    }): this;
    order(column: string, options?: {
        ascending?: boolean;
        nullsFirst?: boolean;
        referencedTable?: string;
    }): this;
    order<ColumnName extends string & keyof Row>(column: ColumnName, options?: {
        ascending?: boolean;
        nullsFirst?: boolean;
        foreignTable?: undefined;
    }): this;
    order(column: string, options?: {
        ascending?: boolean;
        nullsFirst?: boolean;
        foreignTable?: string;
    }): this;
    limit(rows: number, { foreignTable, referencedTable, }?: {
        foreignTable?: string;
        referencedTable?: string;
    }): this;
    range(from: number, to: number, { foreignTable, referencedTable, }?: {
        foreignTable?: string;
        referencedTable?: string;
    }): this;
    abortSignal(signal: AbortSignal): this;
    single<ResultOne = Result extends (infer ResultOne)[] ? ResultOne : never>(): PostgrestBuilder<ClientOptions, ResultOne, ThrowOnError>;
    maybeSingle<ResultOne = Result extends (infer ResultOne)[] ? ResultOne : never>(): PostgrestBuilder<ClientOptions, ResultOne | null, ThrowOnError>;
    csv(): PostgrestBuilder<ClientOptions, string, ThrowOnError>;
    geojson(): PostgrestBuilder<ClientOptions, Record<string, unknown>, ThrowOnError>;
    explain({ analyze, verbose, settings, buffers, wal, format, }?: {
        analyze?: boolean;
        verbose?: boolean;
        settings?: boolean;
        buffers?: boolean;
        wal?: boolean;
        format?: "json" | "text";
    }): PostgrestBuilder<ClientOptions, string, ThrowOnError> | PostgrestBuilder<ClientOptions, Record<string, unknown>[], ThrowOnError>;
    rollback(): this;
    returns<NewResult>(): PostgrestTransformBuilder<ClientOptions, Schema, Row, CheckMatchingArrayTypes<Result, NewResult>, RelationName, Relationships, Method, ThrowOnError>;
    maxAffected(rows: number): MaxAffectedEnabled<ClientOptions["PostgrestVersion"]> extends true ? Method extends "PATCH" | "DELETE" | "RPC" ? this : InvalidMethodError<"maxAffected method only available on update or delete"> : InvalidMethodError<"maxAffected method only available on postgrest 13+">;
}
type FilterOperator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "like" | "ilike" | "is" | "isdistinct" | "in" | "cs" | "cd" | "sl" | "sr" | "nxl" | "nxr" | "adj" | "ov" | "fts" | "plfts" | "phfts" | "wfts" | "match" | "imatch";
type IsStringOperator<Path extends string> = Path extends `${string}->>${string}` ? true : false;
type ResolveFilterValue<Schema extends GenericSchema, Row extends Record<string, unknown>, ColumnName extends string> = ColumnName extends `${infer RelationshipTable}.${infer Remainder}` ? Remainder extends `${infer _}.${infer _}` ? ResolveFilterValue<Schema, Row, Remainder> : ResolveFilterRelationshipValue<Schema, RelationshipTable, Remainder> : ColumnName extends keyof Row ? Row[ColumnName] : IsStringOperator<ColumnName> extends true ? string : JsonPathToType<Row, JsonPathToAccessor<ColumnName>> extends infer JsonPathValue ? JsonPathValue extends never ? never : JsonPathValue : never;
type ResolveFilterRelationshipValue<Schema extends GenericSchema, RelationshipTable extends string, RelationshipColumn extends string> = Schema["Tables"] & Schema["Views"] extends infer TablesAndViews ? RelationshipTable extends keyof TablesAndViews ? "Row" extends keyof TablesAndViews[RelationshipTable] ? RelationshipColumn extends keyof TablesAndViews[RelationshipTable]["Row"] ? TablesAndViews[RelationshipTable]["Row"][RelationshipColumn] : unknown : unknown : unknown : never;
type InvalidMethodError<S extends string> = {
    Error: S;
};
type NonNullableColumn<T extends Record<string, unknown>, Col extends string> = Col extends keyof T ? {
    [K in keyof T]: K extends Col ? NonNullable<T[K]> : T[K];
} : T;
type NarrowResultColumn<T, Col extends string> = T extends (infer Item)[] ? Item extends Record<string, unknown> ? Col extends keyof Item ? {
    [K in keyof Item]: K extends Col ? NonNullable<Item[K]> : Item[K];
}[] : T : T : T extends Record<string, unknown> ? Col extends keyof T ? {
    [K in keyof T]: K extends Col ? NonNullable<T[K]> : T[K];
} : T : T;
export declare class PostgrestFilterBuilder<ClientOptions extends ClientServerOptions, Schema extends GenericSchema, Row extends Record<string, unknown>, Result, RelationName = unknown, Relationships = unknown, Method = unknown, ThrowOnError extends boolean = false> extends PostgrestTransformBuilder<ClientOptions, Schema, Row, Result, RelationName, Relationships, Method, ThrowOnError> {
    throwOnError(): PostgrestFilterBuilder<ClientOptions, Schema, Row, Result, RelationName, Relationships, Method, true>;
    eq<ColumnName extends string>(column: ColumnName extends keyof Row ? ColumnName : ColumnName extends `${string}.${string}` | `${string}->${string}` ? ColumnName : string extends ColumnName ? string : keyof Row, value: ResolveFilterValue<Schema, Row, ColumnName> extends never ? NonNullable<unknown> : ResolveFilterValue<Schema, Row, ColumnName> extends infer ResolvedFilterValue ? NonNullable<ResolvedFilterValue> : never): this;
    neq<ColumnName extends string>(column: ColumnName extends keyof Row ? ColumnName : ColumnName extends `${string}.${string}` | `${string}->${string}` ? ColumnName : string extends ColumnName ? string : keyof Row, value: ResolveFilterValue<Schema, Row, ColumnName> extends never ? unknown : ResolveFilterValue<Schema, Row, ColumnName> extends infer Resolved ? Resolved : never): this;
    gt<ColumnName extends string & keyof Row>(column: ColumnName, value: Row[ColumnName]): this;
    gt(column: string, value: unknown): this;
    gte<ColumnName extends string & keyof Row>(column: ColumnName, value: Row[ColumnName]): this;
    gte(column: string, value: unknown): this;
    lt<ColumnName extends string & keyof Row>(column: ColumnName, value: Row[ColumnName]): this;
    lt(column: string, value: unknown): this;
    lte<ColumnName extends string & keyof Row>(column: ColumnName, value: Row[ColumnName]): this;
    lte(column: string, value: unknown): this;
    like<ColumnName extends string & keyof Row>(column: ColumnName, pattern: string): this;
    like(column: string, pattern: string): this;
    likeAllOf<ColumnName extends string & keyof Row>(column: ColumnName, patterns: readonly string[]): this;
    likeAllOf(column: string, patterns: readonly string[]): this;
    likeAnyOf<ColumnName extends string & keyof Row>(column: ColumnName, patterns: readonly string[]): this;
    likeAnyOf(column: string, patterns: readonly string[]): this;
    ilike<ColumnName extends string & keyof Row>(column: ColumnName, pattern: string): this;
    ilike(column: string, pattern: string): this;
    ilikeAllOf<ColumnName extends string & keyof Row>(column: ColumnName, patterns: readonly string[]): this;
    ilikeAllOf(column: string, patterns: readonly string[]): this;
    ilikeAnyOf<ColumnName extends string & keyof Row>(column: ColumnName, patterns: readonly string[]): this;
    ilikeAnyOf(column: string, patterns: readonly string[]): this;
    regexMatch<ColumnName extends string & keyof Row>(column: ColumnName, pattern: string): this;
    regexMatch(column: string, pattern: string): this;
    regexIMatch<ColumnName extends string & keyof Row>(column: ColumnName, pattern: string): this;
    regexIMatch(column: string, pattern: string): this;
    is<ColumnName extends string & keyof Row>(column: ColumnName, value: Row[ColumnName] & (boolean | null)): this;
    is(column: string, value: boolean | null): this;
    isDistinct<ColumnName extends string>(column: ColumnName, value: ResolveFilterValue<Schema, Row, ColumnName> extends never ? unknown : ResolveFilterValue<Schema, Row, ColumnName> extends infer ResolvedFilterValue ? ResolvedFilterValue : never): this;
    in<ColumnName extends string>(column: ColumnName, values: ReadonlyArray<ResolveFilterValue<Schema, Row, ColumnName> extends never ? unknown : ResolveFilterValue<Schema, Row, ColumnName> extends infer ResolvedFilterValue ? ResolvedFilterValue : never>): this;
    notIn<ColumnName extends string>(column: ColumnName, values: ReadonlyArray<ResolveFilterValue<Schema, Row, ColumnName> extends never ? unknown : ResolveFilterValue<Schema, Row, ColumnName> extends infer ResolvedFilterValue ? ResolvedFilterValue : never>): this;
    contains<ColumnName extends string & keyof Row>(column: ColumnName, value: string | ReadonlyArray<Row[ColumnName]> | Record<string, unknown>): this;
    contains(column: string, value: string | readonly unknown[] | Record<string, unknown>): this;
    containedBy<ColumnName extends string & keyof Row>(column: ColumnName, value: string | ReadonlyArray<Row[ColumnName]> | Record<string, unknown>): this;
    containedBy(column: string, value: string | readonly unknown[] | Record<string, unknown>): this;
    rangeGt<ColumnName extends string & keyof Row>(column: ColumnName, range: string): this;
    rangeGt(column: string, range: string): this;
    rangeGte<ColumnName extends string & keyof Row>(column: ColumnName, range: string): this;
    rangeGte(column: string, range: string): this;
    rangeLt<ColumnName extends string & keyof Row>(column: ColumnName, range: string): this;
    rangeLt(column: string, range: string): this;
    rangeLte<ColumnName extends string & keyof Row>(column: ColumnName, range: string): this;
    rangeLte(column: string, range: string): this;
    rangeAdjacent<ColumnName extends string & keyof Row>(column: ColumnName, range: string): this;
    rangeAdjacent(column: string, range: string): this;
    overlaps<ColumnName extends string & keyof Row>(column: ColumnName, value: string | ReadonlyArray<Row[ColumnName]>): this;
    overlaps(column: string, value: string | readonly unknown[]): this;
    textSearch<ColumnName extends string & keyof Row>(column: ColumnName, query: string, options?: {
        config?: string;
        type?: "plain" | "phrase" | "websearch";
    }): this;
    textSearch(column: string, query: string, options?: {
        config?: string;
        type?: "plain" | "phrase" | "websearch";
    }): this;
    match<ColumnName extends string & keyof Row>(query: Record<ColumnName, Row[ColumnName]>): this;
    match(query: Record<string, unknown>): this;
    not<ColumnName extends string & keyof Row>(column: ColumnName, operator: "is", value: null): PostgrestFilterBuilder<ClientOptions, Schema, NonNullableColumn<Row, ColumnName>, NarrowResultColumn<Result, ColumnName>, RelationName, Relationships, Method, ThrowOnError> & this;
    not<ColumnName extends string & keyof Row>(column: ColumnName, operator: FilterOperator, value: Row[ColumnName]): this;
    not(column: string, operator: string, value: unknown): this;
    or(filters: string, { foreignTable, referencedTable, }?: {
        foreignTable?: string;
        referencedTable?: string;
    }): this;
    filter<ColumnName extends string & keyof Row>(column: ColumnName, operator: `${"" | "not."}${FilterOperator}`, value: unknown): this;
    filter(column: string, operator: string, value: unknown): this;
}
export declare class PostgrestQueryBuilder<ClientOptions extends ClientServerOptions, Schema extends GenericSchema, Relation extends GenericTable | GenericView, RelationName = unknown, Relationships = Relation extends {
    Relationships: infer R;
} ? R : unknown> {
    url: URL;
    headers: Headers;
    schema?: string;
    signal?: AbortSignal;
    fetch?: Fetch;
    urlLengthLimit: number;
    retry?: boolean;
    constructor(url: URL, { headers, schema, fetch, urlLengthLimit, retry, }: {
        headers?: HeadersInit;
        schema?: string;
        fetch?: Fetch;
        urlLengthLimit?: number;
        retry?: boolean;
    });
    private cloneRequestState;
    select<Query extends string = "*", ResultOne = GetResult<Schema, Relation["Row"], RelationName, Relationships, Query, ClientOptions>>(columns?: Query, options?: {
        head?: boolean;
        count?: "exact" | "planned" | "estimated" | (string & {});
    }): PostgrestFilterBuilder<ClientOptions, Schema, Relation["Row"], ResultOne[], RelationName, Relationships, "GET">;
    insert<Row extends Relation extends {
        Insert: unknown;
    } ? Relation["Insert"] : never>(values: RejectExcessProperties<Relation extends {
        Insert: unknown;
    } ? Relation["Insert"] : never, Row> | RejectExcessProperties<Relation extends {
        Insert: unknown;
    } ? Relation["Insert"] : never, Row>[], { count, defaultToNull, }?: {
        count?: "exact" | "planned" | "estimated" | (string & {});
        defaultToNull?: boolean;
    }): PostgrestFilterBuilder<ClientOptions, Schema, Relation["Row"], null, RelationName, Relationships, "POST">;
    upsert<Row extends Relation extends {
        Insert: unknown;
    } ? Relation["Insert"] : never>(values: RejectExcessProperties<Relation extends {
        Insert: unknown;
    } ? Relation["Insert"] : never, Row> | RejectExcessProperties<Relation extends {
        Insert: unknown;
    } ? Relation["Insert"] : never, Row>[], { onConflict, ignoreDuplicates, count, defaultToNull, }?: {
        onConflict?: string;
        ignoreDuplicates?: boolean;
        count?: "exact" | "planned" | "estimated" | (string & {});
        defaultToNull?: boolean;
    }): PostgrestFilterBuilder<ClientOptions, Schema, Relation["Row"], null, RelationName, Relationships, "POST">;
    update<Row extends Relation extends {
        Update: unknown;
    } ? Relation["Update"] : never>(values: RejectExcessProperties<Relation extends {
        Update: unknown;
    } ? Relation["Update"] : never, Row>, { count, }?: {
        count?: "exact" | "planned" | "estimated" | (string & {});
    }): PostgrestFilterBuilder<ClientOptions, Schema, Relation["Row"], null, RelationName, Relationships, "PATCH">;
    delete({ count, }?: {
        count?: "exact" | "planned" | "estimated" | (string & {});
    }): PostgrestFilterBuilder<ClientOptions, Schema, Relation["Row"], null, RelationName, Relationships, "DELETE">;
}
type IsMatchingArgs<FnArgs extends GenericFunction["Args"], PassedArgs extends GenericFunction["Args"]> = [
    FnArgs
] extends [
    Record<PropertyKey, never>
] ? PassedArgs extends Record<PropertyKey, never> ? true : false : keyof PassedArgs extends keyof FnArgs ? PassedArgs extends FnArgs ? true : false : false;
type MatchingFunctionArgs<Fn extends GenericFunction, Args extends GenericFunction["Args"]> = Fn extends {
    Args: infer A extends GenericFunction["Args"];
} ? IsMatchingArgs<A, Args> extends true ? Fn : never : false;
type FindMatchingFunctionByArgs<FnUnion, Args extends GenericFunction["Args"]> = FnUnion extends infer Fn extends GenericFunction ? MatchingFunctionArgs<Fn, Args> : false;
type TablesAndViews$1<Schema extends GenericSchema> = Schema["Tables"] & Exclude<Schema["Views"], "">;
type UnionToIntersection$1<U> = (U extends any ? (k: U) => void : never) extends (k: infer I) => void ? I : never;
type LastOf$1<T> = UnionToIntersection$1<T extends any ? () => T : never> extends () => infer R ? R : never;
type IsAny$1<T> = 0 extends 1 & T ? true : false;
type ExactMatch<T, S> = [
    T
] extends [
    S
] ? ([
    S
] extends [
    T
] ? true : false) : false;
type ExtractExactFunction<Fns, Args> = Fns extends infer F ? F extends GenericFunction ? ExactMatch<F["Args"], Args> extends true ? F : never : never : never;
type IsNever<T> = [
    T
] extends [
    never
] ? true : false;
type RpcFunctionNotFound<FnName> = {
    Row: any;
    Result: {
        error: true;
    } & "Couldn't infer function definition matching provided arguments";
    RelationName: FnName;
    Relationships: null;
};
type CrossSchemaError<TableRef extends string> = {
    error: true;
} & `Function returns SETOF from a different schema ('${TableRef}'). Use .overrideTypes<YourReturnType>() to specify the return type explicitly.`;
type GetRpcFunctionFilterBuilderByArgs<Schema extends GenericSchema, FnName extends string & keyof Schema["Functions"], Args> = {
    0: Schema["Functions"][FnName];
    1: IsAny$1<Schema> extends true ? any : IsNever<Args> extends true ? IsNever<ExtractExactFunction<Schema["Functions"][FnName], Args>> extends true ? LastOf$1<Schema["Functions"][FnName]> : ExtractExactFunction<Schema["Functions"][FnName], Args> : Args extends Record<PropertyKey, never> ? LastOf$1<Schema["Functions"][FnName]> : Args extends GenericFunction["Args"] ? IsNever<LastOf$1<FindMatchingFunctionByArgs<Schema["Functions"][FnName], Args>>> extends true ? LastOf$1<Schema["Functions"][FnName]> : LastOf$1<FindMatchingFunctionByArgs<Schema["Functions"][FnName], Args>> : ExtractExactFunction<Schema["Functions"][FnName], Args> extends GenericFunction ? ExtractExactFunction<Schema["Functions"][FnName], Args> : any;
}[1] extends infer Fn ? IsAny$1<Fn> extends true ? {
    Row: any;
    Result: any;
    RelationName: FnName;
    Relationships: null;
} : Fn extends GenericFunction ? {
    Row: Fn["SetofOptions"] extends GenericSetofOption ? Fn["SetofOptions"]["to"] extends keyof TablesAndViews$1<Schema> ? TablesAndViews$1<Schema>[Fn["SetofOptions"]["to"]]["Row"] : Fn["Returns"] extends any[] ? Fn["Returns"][number] extends Record<string, unknown> ? Fn["Returns"][number] : CrossSchemaError<Fn["SetofOptions"]["to"] & string> : Fn["Returns"] extends Record<string, unknown> ? Fn["Returns"] : CrossSchemaError<Fn["SetofOptions"]["to"] & string> : Fn["Returns"] extends any[] ? Fn["Returns"][number] extends Record<string, unknown> ? Fn["Returns"][number] : never : Fn["Returns"] extends Record<string, unknown> ? Fn["Returns"] : never;
    Result: Fn["SetofOptions"] extends GenericSetofOption ? Fn["SetofOptions"]["isSetofReturn"] extends true ? Fn["SetofOptions"]["isOneToOne"] extends true ? Fn["Returns"][] : Fn["Returns"] : Fn["Returns"] : Fn["Returns"];
    RelationName: Fn["SetofOptions"] extends GenericSetofOption ? Fn["SetofOptions"]["to"] : FnName;
    Relationships: Fn["SetofOptions"] extends GenericSetofOption ? Fn["SetofOptions"]["to"] extends keyof Schema["Tables"] ? Schema["Tables"][Fn["SetofOptions"]["to"]]["Relationships"] : Fn["SetofOptions"]["to"] extends keyof Schema["Views"] ? Schema["Views"][Fn["SetofOptions"]["to"]]["Relationships"] : null : null;
} : Fn extends false ? RpcFunctionNotFound<FnName> : RpcFunctionNotFound<FnName> : RpcFunctionNotFound<FnName>;
declare class PostgrestClient<Database = any, ClientOptions extends ClientServerOptions = Database extends {
    __InternalSupabase: infer I extends ClientServerOptions;
} ? I : {}, SchemaName extends string & keyof Omit<Database, "__InternalSupabase"> = "public" extends keyof Omit<Database, "__InternalSupabase"> ? "public" : string & keyof Omit<Database, "__InternalSupabase">, Schema extends GenericSchema = Omit<Database, "__InternalSupabase">[SchemaName] extends GenericSchema ? Omit<Database, "__InternalSupabase">[SchemaName] : any> {
    url: string;
    headers: Headers;
    schemaName?: SchemaName;
    fetch?: Fetch;
    urlLengthLimit: number;
    retry?: boolean;
    constructor(url: string, { headers, schema, fetch, timeout, urlLengthLimit, retry, }?: {
        headers?: HeadersInit;
        schema?: SchemaName;
        fetch?: Fetch;
        timeout?: number;
        urlLengthLimit?: number;
        retry?: boolean;
    });
    from<TableName extends string & keyof Schema["Tables"], Table extends Schema["Tables"][TableName]>(relation: TableName): PostgrestQueryBuilder<ClientOptions, Schema, Table, TableName>;
    from<ViewName extends string & keyof Schema["Views"], View extends Schema["Views"][ViewName]>(relation: ViewName): PostgrestQueryBuilder<ClientOptions, Schema, View, ViewName>;
    schema<DynamicSchema extends string & keyof Omit<Database, "__InternalSupabase">>(schema: DynamicSchema): PostgrestClient<Database, ClientOptions, DynamicSchema, Database[DynamicSchema] extends GenericSchema ? Database[DynamicSchema] : any>;
    rpc<FnName extends string & keyof Schema["Functions"], Args extends Schema["Functions"][FnName]["Args"] = never, FilterBuilder extends GetRpcFunctionFilterBuilderByArgs<Schema, FnName, Args> = GetRpcFunctionFilterBuilderByArgs<Schema, FnName, Args>>(fn: FnName, args?: Args, { head, get, count, }?: {
        head?: boolean;
        get?: boolean;
        count?: "exact" | "planned" | "estimated" | (string & {});
    }): PostgrestFilterBuilder<ClientOptions, Schema, FilterBuilder["Row"], FilterBuilder["Result"], FilterBuilder["RelationName"], FilterBuilder["Relationships"], "RPC">;
}
type Fetch$1 = typeof fetch;
export interface UserAppMetadata {
    provider?: string;
    providers?: string[];
    [key: string]: any;
}
export interface UserMetadata {
    [key: string]: any;
}
export interface UserIdentity {
    id: string;
    user_id: string;
    identity_data?: {
        [key: string]: any;
    };
    identity_id: string;
    provider: string;
    created_at?: string;
    last_sign_in_at?: string;
    updated_at?: string;
}
export interface Factor {
    id: string;
    friendly_name?: string;
    factor_type: "totp" | "phone" | "webauthn";
    status: "verified" | "unverified";
    created_at: string;
    updated_at: string;
    last_challenged_at?: string;
}
export interface User {
    id: string;
    app_metadata: UserAppMetadata;
    user_metadata: UserMetadata;
    aud: string;
    confirmation_sent_at?: string;
    recovery_sent_at?: string;
    email_change_sent_at?: string;
    new_email?: string;
    new_phone?: string;
    invited_at?: string;
    action_link?: string;
    email?: string;
    phone?: string;
    created_at: string;
    confirmed_at?: string;
    email_confirmed_at?: string;
    phone_confirmed_at?: string;
    last_sign_in_at?: string;
    role?: string;
    updated_at?: string;
    identities?: UserIdentity[];
    is_anonymous?: boolean;
    is_sso_user?: boolean;
    factors?: Factor[];
    deleted_at?: string;
    banned_until?: string;
}
export interface Session {
    provider_token?: string | null;
    provider_refresh_token?: string | null;
    access_token: string;
    refresh_token: string;
    expires_in: number;
    expires_at?: number;
    token_type: "bearer";
    user: User;
}
export type AuthChangeEvent = "INITIAL_SESSION" | "PASSWORD_RECOVERY" | "SIGNED_IN" | "SIGNED_OUT" | "TOKEN_REFRESHED" | "USER_UPDATED" | "MFA_CHALLENGE_VERIFIED";
export type Provider = "google" | "apple" | "azure" | "facebook" | "github" | "gitlab" | "twitter" | (string & {});
export interface UserAttributes {
    current_password?: string;
    email?: string;
    phone?: string;
    password?: string;
    nonce?: string;
    data?: object;
}
export type EmailOtpType = "signup" | "invite" | "magiclink" | "recovery" | "email_change" | "email";
export type MobileOtpType = "sms" | "phone_change";
export interface VerifyOtpParams {
    type: EmailOtpType | MobileOtpType;
    token?: string;
    token_hash?: string;
    email?: string;
    phone?: string;
    options?: {
        redirectTo?: string;
        captchaToken?: string;
    };
}
export interface SupportedStorage {
    getItem(key: string): string | null | Promise<string | null>;
    setItem(key: string, value: string): void | Promise<void>;
    removeItem(key: string): void | Promise<void>;
}
export interface Subscription {
    id: string;
    callback: (event: AuthChangeEvent, session: Session | null) => void | Promise<void>;
    unsubscribe: () => void;
}
export interface SupabaseClientOptions<SchemaName = string> {
    db?: {
        schema?: SchemaName;
    };
    auth?: {
        storage?: SupportedStorage;
        persistSession?: boolean;
        autoRefreshToken?: boolean;
        detectSessionInUrl?: boolean;
        storageKey?: string;
        flowType?: "implicit" | "pkce";
    };
    global?: {
        headers?: Record<string, string>;
        fetch?: Fetch$1;
    };
    realtime?: Record<string, unknown>;
}
export declare class AuthError extends Error {
    status: number | undefined;
    code: string | undefined;
    protected __isAuthError: boolean;
    constructor(message: string, status?: number, code?: string);
}
export declare class AuthApiError extends AuthError {
    status: number;
    constructor(message: string, status: number, code?: string);
}
export declare class AuthSessionMissingError extends AuthError {
    constructor();
}
export declare class AuthRetryableFetchError extends AuthError {
    constructor(message: string, status: number);
}
export declare class AuthWeakPasswordError extends AuthApiError {
    reasons: string[];
    constructor(message: string, status: number, reasons: string[]);
}
export declare class AuthImplicitGrantRedirectError extends AuthError {
    details: {
        error: string;
        code: string;
    } | null;
    constructor(message: string, details?: {
        error: string;
        code: string;
    } | null);
}
export declare const isAuthError: (error: unknown) => error is AuthError;
type Result<T> = {
    data: T;
    error: null;
} | {
    data: {
        [K in keyof T]: null;
    };
    error: AuthError;
};
interface AuthClientOptions {
    url: string;
    headers: Record<string, string>;
    storageKey: string;
    storage?: SupportedStorage;
    persistSession?: boolean;
    autoRefreshToken?: boolean;
    detectSessionInUrl?: boolean;
    fetch?: Fetch$1;
    hasCustomAuthorizationHeader?: boolean;
}
interface RequestOptions {
    body?: unknown;
    jwt?: string;
    redirectTo?: string;
    query?: Record<string, string | undefined>;
}
declare class AuthHttp {
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly fetch: Fetch$1;
    constructor(url: string, headers: Record<string, string>, fetch: Fetch$1);
    request(method: string, path: string, opts?: RequestOptions): Promise<{
        data: any;
        error: AuthError | null;
        headers?: Headers;
    }>;
}
declare class AuthAdminApi {
    private http;
    constructor(http: AuthHttp);
    deleteUser(id: string, _shouldSoftDelete?: boolean): Promise<Result<{
        user: null;
    }>>;
    listUsers(params?: {
        page?: number;
        perPage?: number;
    }): Promise<{
        data: {
            users: User[];
            aud: string;
            nextPage: number | null;
            lastPage: number;
            total: number;
        };
        error: null;
    } | {
        data: {
            users: [
            ];
        };
        error: AuthError;
    }>;
}
declare class SelfbaseAuthClient {
    admin: AuthAdminApi;
    protected http: AuthHttp;
    protected storage: SupportedStorage;
    protected storageKey: string;
    protected persistSession: boolean;
    protected autoRefreshToken: boolean;
    protected detectSessionInUrl: boolean;
    protected hasCustomAuthorizationHeader: boolean;
    protected session: Session | null;
    protected subscribers: Map<string, Subscription>;
    protected initializePromise: Promise<unknown>;
    protected initError: AuthError | null;
    protected refreshTimer: ReturnType<typeof setTimeout> | undefined;
    protected refreshing: Promise<{
        session: Session | null;
        error: AuthError | null;
    }> | null;
    protected epoch: number;
    constructor(options: AuthClientOptions);
    initialize(): Promise<{
        error: AuthError | null;
    }>;
    protected sessionFromUrl(): Promise<void>;
    protected recoverSession(): Promise<void>;
    protected expiresSoon(s: Session): boolean;
    protected saveSession(session: Session): Promise<void>;
    protected removeSession(): Promise<void>;
    protected scheduleRefresh(session: Session, delay?: number): void;
    protected callRefresh(refreshToken: string): Promise<{
        session: Session | null;
        error: AuthError | null;
    }>;
    protected onStorageEvent(e: StorageEvent): Promise<void>;
    protected notify(event: AuthChangeEvent, session: Session | null): Promise<void>;
    onAuthStateChange(callback: (event: AuthChangeEvent, session: Session | null) => void | Promise<void>): {
        data: {
            subscription: Subscription;
        };
    };
    getSession(): Promise<Result<{
        session: Session | null;
    }>>;
    getUser(jwt?: string): Promise<Result<{
        user: User | null;
    }>>;
    protected sessionResult(data: any, event?: AuthChangeEvent): Promise<{
        data: {
            user: User | null;
            session: Session | null;
        };
        error: null;
    }>;
    signUp(credentials: {
        email?: string;
        phone?: string;
        password: string;
        options?: {
            emailRedirectTo?: string;
            data?: object;
            captchaToken?: string;
        };
    }): Promise<Result<{
        user: User | null;
        session: Session | null;
    }>>;
    signInWithPassword(credentials: {
        email?: string;
        phone?: string;
        password: string;
        options?: {
            captchaToken?: string;
        };
    }): Promise<Result<{
        user: User | null;
        session: Session | null;
    }>>;
    signInWithOAuth(credentials: {
        provider: Provider;
        options?: {
            redirectTo?: string;
            scopes?: string;
            queryParams?: Record<string, string>;
            skipBrowserRedirect?: boolean;
        };
    }): Promise<Result<{
        provider: Provider;
        url: string;
    }>>;
    signInWithOtp(credentials: {
        email?: string;
        phone?: string;
        options?: {
            emailRedirectTo?: string;
            shouldCreateUser?: boolean;
            data?: object;
            captchaToken?: string;
        };
    }): Promise<Result<{
        user: null;
        session: null;
    }>>;
    verifyOtp(params: VerifyOtpParams): Promise<Result<{
        user: User | null;
        session: Session | null;
    }>>;
    resend(params: {
        type: "signup" | "email_change" | "sms" | "phone_change";
        email?: string;
        phone?: string;
        options?: {
            emailRedirectTo?: string;
            captchaToken?: string;
        };
    }): Promise<Result<{
        user: null;
        session: null;
    }>>;
    resetPasswordForEmail(email: string, options?: {
        redirectTo?: string;
        captchaToken?: string;
    }): Promise<{
        data: {};
        error: null;
    } | {
        data: null;
        error: AuthError;
    }>;
    updateUser(attributes: UserAttributes, options?: {
        emailRedirectTo?: string;
    }): Promise<Result<{
        user: User | null;
    }>>;
    refreshSession(current?: {
        refresh_token: string;
    }): Promise<Result<{
        user: User | null;
        session: Session | null;
    }>>;
    setSession(current: {
        access_token: string;
        refresh_token: string;
    }): Promise<Result<{
        user: User | null;
        session: Session | null;
    }>>;
    signOut(options?: {
        scope?: "global" | "local" | "others";
    }): Promise<{
        error: AuthError | null;
    }>;
}
export declare class FunctionsError extends Error {
    context: any;
    constructor(message: string, name?: string, context?: any);
}
export declare class FunctionsHttpError extends FunctionsError {
    constructor(context: Response);
}
export declare class FunctionsRelayError extends FunctionsError {
    constructor(context: Response);
}
export declare class FunctionsFetchError extends FunctionsError {
    constructor(context: unknown);
}
export interface FunctionInvokeOptions {
    headers?: Record<string, string>;
    method?: "POST" | "GET" | "PUT" | "PATCH" | "DELETE";
    body?: File | Blob | ArrayBuffer | FormData | ReadableStream<Uint8Array> | Record<string, any> | string;
    signal?: AbortSignal;
}
export type FunctionsResponse<T> = {
    data: T;
    error: null;
    response?: Response;
} | {
    data: null;
    error: FunctionsError;
    response?: Response;
};
declare class FunctionsClient {
    protected url: string;
    protected headers: Record<string, string>;
    protected fetch: Fetch$1;
    constructor(url: string, headers: Record<string, string>, fetch: Fetch$1);
    invoke<T = any>(functionName: string, options?: FunctionInvokeOptions): Promise<FunctionsResponse<T>>;
}
type RealtimePostgresChangesEvent = "*" | "INSERT" | "UPDATE" | "DELETE";
export declare const REALTIME_SUBSCRIBE_STATES: {
    readonly SUBSCRIBED: "SUBSCRIBED";
    readonly TIMED_OUT: "TIMED_OUT";
    readonly CLOSED: "CLOSED";
    readonly CHANNEL_ERROR: "CHANNEL_ERROR";
};
export type REALTIME_SUBSCRIBE_STATES = (typeof REALTIME_SUBSCRIBE_STATES)[keyof typeof REALTIME_SUBSCRIBE_STATES];
type PayloadBase = {
    schema: string;
    table: string;
    commit_timestamp: string;
    errors: string[] | null;
};
export type RealtimePostgresInsertPayload<T extends {
    [key: string]: any;
}> = PayloadBase & {
    eventType: "INSERT";
    new: T;
    old: {};
};
export type RealtimePostgresUpdatePayload<T extends {
    [key: string]: any;
}> = PayloadBase & {
    eventType: "UPDATE";
    new: T;
    old: Partial<T>;
};
export type RealtimePostgresDeletePayload<T extends {
    [key: string]: any;
}> = PayloadBase & {
    eventType: "DELETE";
    new: {};
    old: Partial<T>;
};
export type RealtimePostgresChangesPayload<T extends {
    [key: string]: any;
}> = RealtimePostgresInsertPayload<T> | RealtimePostgresUpdatePayload<T> | RealtimePostgresDeletePayload<T>;
export type RealtimePostgresChangesFilter<T extends RealtimePostgresChangesEvent> = {
    event: T;
    schema: string;
    table?: string;
    filter?: string;
};
type RealtimeChannelSendResponse = "ok" | "timed out" | "error";
type RealtimeRemoveChannelResponse = "ok" | "timed out" | "error";
type SubscribeCallback = (status: REALTIME_SUBSCRIBE_STATES, err?: Error) => void;
interface Binding {
    ref: string;
    filter: RealtimePostgresChangesFilter<RealtimePostgresChangesEvent>;
    callback: (payload: any) => void;
    subscribed: boolean;
}
export declare class RealtimeChannel {
    subTopic: string;
    protected socket: RealtimeClient;
    topic: string;
    state: "closed" | "joining" | "joined" | "errored";
    bindings: Binding[];
    protected statusCallback: SubscribeCallback | undefined;
    protected timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    constructor(subTopic: string, socket: RealtimeClient);
    on<T extends {
        [key: string]: any;
    }>(type: "postgres_changes", filter: RealtimePostgresChangesFilter<"*">, callback: (payload: RealtimePostgresChangesPayload<T>) => void): RealtimeChannel;
    on<T extends {
        [key: string]: any;
    }>(type: "postgres_changes", filter: RealtimePostgresChangesFilter<"INSERT">, callback: (payload: RealtimePostgresInsertPayload<T>) => void): RealtimeChannel;
    on<T extends {
        [key: string]: any;
    }>(type: "postgres_changes", filter: RealtimePostgresChangesFilter<"UPDATE">, callback: (payload: RealtimePostgresUpdatePayload<T>) => void): RealtimeChannel;
    on<T extends {
        [key: string]: any;
    }>(type: "postgres_changes", filter: RealtimePostgresChangesFilter<"DELETE">, callback: (payload: RealtimePostgresDeletePayload<T>) => void): RealtimeChannel;
    subscribe(callback?: SubscribeCallback, timeout?: number): RealtimeChannel;
    unsubscribe(): Promise<RealtimeChannelSendResponse>;
    _resubscribeAll(): void;
    _onSubscribed(ref: string): void;
    protected _markJoined(): void;
    _onError(message: string): void;
    _onDisconnected(): void;
    _onChange(ref: string, msg: any): void;
}
interface RealtimeClientOptions {
    apikey: string;
    accessToken?: () => Promise<string | null>;
    transport?: typeof WebSocket;
    heartbeatIntervalMs?: number;
    reconnectAfterMs?: (tries: number) => number;
}
export declare class RealtimeClient {
    endPoint: string;
    protected options: RealtimeClientOptions;
    channels: RealtimeChannel[];
    protected ws: WebSocket | null;
    protected connecting: boolean;
    protected token: string | null;
    protected refCounter: number;
    protected refs: Map<string, RealtimeChannel>;
    protected tries: number;
    protected reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    protected heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    protected stableTimer: ReturnType<typeof setTimeout> | undefined;
    protected pendingPong: boolean;
    constructor(endPoint: string, options: RealtimeClientOptions);
    makeRef(): string;
    channel(name: string, _opts?: unknown): RealtimeChannel;
    getChannels(): RealtimeChannel[];
    removeChannel(channel: RealtimeChannel): Promise<RealtimeRemoveChannelResponse>;
    removeAllChannels(): Promise<RealtimeRemoveChannelResponse[]>;
    isConnected(): boolean;
    setAuth(token?: string | null): void;
    join(channel: RealtimeChannel): void;
    leave(channel: RealtimeChannel): void;
    sendSubscribe(channel: RealtimeChannel, b: {
        ref: string;
        filter: RealtimePostgresChangesFilter<RealtimePostgresChangesEvent>;
    }): void;
    send(msg: unknown): void;
    connect(): Promise<void>;
    disconnect(): void;
    protected scheduleReconnect(): void;
    protected startHeartbeat(): void;
    protected onMessage(raw: unknown): void;
}
export declare class StorageError extends Error {
    protected __isStorageError: boolean;
    constructor(message: string);
}
export declare class StorageApiError extends StorageError {
    status: number;
    statusCode: string;
    constructor(message: string, status: number, statusCode: string);
}
export declare class StorageUnknownError extends StorageError {
    originalError: unknown;
    constructor(message: string, originalError: unknown);
}
type Result$1<T> = {
    data: T;
    error: null;
} | {
    data: null;
    error: StorageError;
};
export interface FileObject {
    name: string;
    bucket_id: string;
    owner: string;
    id: string;
    updated_at: string;
    created_at: string;
    last_accessed_at: string;
    metadata: Record<string, any>;
    buckets?: unknown;
}
export interface FileOptions {
    cacheControl?: string;
    contentType?: string;
    upsert?: boolean;
    duplex?: string;
    metadata?: Record<string, any>;
    headers?: Record<string, string>;
}
export interface SearchOptions {
    limit?: number;
    offset?: number;
    sortBy?: {
        column?: string;
        order?: string;
    };
    search?: string;
}
type FileBody = ArrayBuffer | ArrayBufferView | Blob | File | FormData | ReadableStream<Uint8Array> | URLSearchParams | string;
declare class StorageFileApi {
    protected url: string;
    protected headers: Record<string, string>;
    protected bucketId: string;
    protected fetch: Fetch$1;
    constructor(url: string, headers: Record<string, string>, bucketId: string, fetch: Fetch$1);
    protected request(method: string, path: string, init?: {
        body?: BodyInit | null;
        json?: unknown;
        headers?: Record<string, string>;
    }): Promise<{
        res: null;
        error: StorageApiError;
    } | {
        res: Response;
        error: null;
    } | {
        res: null;
        error: StorageUnknownError;
    }>;
    upload(path: string, fileBody: FileBody, options?: FileOptions): Promise<Result$1<{
        id: string;
        path: string;
        fullPath: string;
    }>>;
    protected uploadOrUpdate(method: string, path: string, fileBody: FileBody, options: FileOptions): Promise<{
        data: null;
        error: StorageApiError | StorageUnknownError;
    } | {
        data: {
            path: string;
            id: any;
            fullPath: any;
        };
        error: null;
    }>;
    remove(paths: string[]): Promise<Result$1<FileObject[]>>;
    download(path: string): Promise<Result$1<Blob>>;
    list(path?: string, options?: SearchOptions): Promise<Result$1<FileObject[]>>;
    createSignedUrl(path: string, expiresIn: number, options?: {
        download?: string | boolean;
    }): Promise<Result$1<{
        signedUrl: string;
    }>>;
    getPublicUrl(path: string, options?: {
        download?: string | boolean;
    }): {
        data: {
            publicUrl: string;
        };
    };
}
declare class StorageClient {
    protected url: string;
    protected headers: Record<string, string>;
    protected fetch: Fetch$1;
    constructor(url: string, headers: Record<string, string>, fetch: Fetch$1);
    from(bucketId: string): StorageFileApi;
}
export declare class SupabaseClient<Database = any, SchemaNameOrClientOptions extends (string & keyof Omit<Database, "__InternalSupabase">) | {
    PostgrestVersion: string;
} = "public" extends keyof Omit<Database, "__InternalSupabase"> ? "public" : string & keyof Omit<Database, "__InternalSupabase">, SchemaName extends string & keyof Omit<Database, "__InternalSupabase"> = SchemaNameOrClientOptions extends string & keyof Omit<Database, "__InternalSupabase"> ? SchemaNameOrClientOptions : "public" extends keyof Omit<Database, "__InternalSupabase"> ? "public" : string & keyof Omit<Omit<Database, "__InternalSupabase">, "__InternalSupabase">, Schema extends Omit<Database, "__InternalSupabase">[SchemaName] extends GenericSchema ? Omit<Database, "__InternalSupabase">[SchemaName] : never = Omit<Database, "__InternalSupabase">[SchemaName] extends GenericSchema ? Omit<Database, "__InternalSupabase">[SchemaName] : never, ClientOptions extends {
    PostgrestVersion: string;
} = SchemaNameOrClientOptions extends string & keyof Omit<Database, "__InternalSupabase"> ? Database extends {
    __InternalSupabase: {
        PostgrestVersion: string;
    };
} ? Database["__InternalSupabase"] : {
    PostgrestVersion: "12";
} : SchemaNameOrClientOptions extends {
    PostgrestVersion: string;
} ? SchemaNameOrClientOptions : never> {
    protected supabaseUrl: string;
    protected supabaseKey: string;
    auth: SelfbaseAuthClient;
    realtime: RealtimeClient;
    storage: StorageClient;
    protected rest: PostgrestClient<Database, ClientOptions, SchemaName>;
    protected headers: Record<string, string>;
    protected fetch: Fetch$1;
    protected functionsUrl: string;
    protected changedAccessToken: string | undefined;
    constructor(supabaseUrl: string, supabaseKey: string, options?: SupabaseClientOptions<SchemaName>);
    get functions(): FunctionsClient;
    from<TableName extends string & keyof Schema["Tables"], Table extends Schema["Tables"][TableName]>(relation: TableName): PostgrestQueryBuilder<ClientOptions, Schema, Table, TableName>;
    from<ViewName extends string & keyof Schema["Views"], View extends Schema["Views"][ViewName]>(relation: ViewName): PostgrestQueryBuilder<ClientOptions, Schema, View, ViewName>;
    schema<DynamicSchema extends string & keyof Omit<Database, "__InternalSupabase">>(schema: DynamicSchema): PostgrestClient<Database, ClientOptions, DynamicSchema, Database[DynamicSchema] extends GenericSchema ? Database[DynamicSchema] : any>;
    rpc<FnName extends string & keyof Schema["Functions"], Args extends Schema["Functions"][FnName]["Args"] = never, FilterBuilder extends GetRpcFunctionFilterBuilderByArgs<Schema, FnName, Args> = GetRpcFunctionFilterBuilderByArgs<Schema, FnName, Args>>(fn: FnName, args?: Args, options?: {
        head?: boolean;
        get?: boolean;
        count?: "exact" | "planned" | "estimated";
    }): PostgrestFilterBuilder<ClientOptions, Schema, FilterBuilder["Row"], FilterBuilder["Result"], FilterBuilder["RelationName"], FilterBuilder["Relationships"], "RPC">;
    channel(name: string, opts?: {
        config?: Record<string, unknown>;
    }): RealtimeChannel;
    getChannels(): RealtimeChannel[];
    removeChannel(channel: RealtimeChannel): Promise<RealtimeRemoveChannelResponse>;
    removeAllChannels(): Promise<RealtimeRemoveChannelResponse[]>;
    protected handleTokenChanged(event: AuthChangeEvent, token?: string): void;
}
export declare const SELFBASE = true;
export declare const createClient: <Database = any, SchemaNameOrClientOptions extends (string & keyof Omit<Database, "__InternalSupabase">) | {
    PostgrestVersion: string;
} = "public" extends keyof Omit<Database, "__InternalSupabase"> ? "public" : string & keyof Omit<Database, "__InternalSupabase">, SchemaName extends string & keyof Omit<Database, "__InternalSupabase"> = SchemaNameOrClientOptions extends string & keyof Omit<Database, "__InternalSupabase"> ? SchemaNameOrClientOptions : "public" extends keyof Omit<Database, "__InternalSupabase"> ? "public" : string & keyof Omit<Omit<Database, "__InternalSupabase">, "__InternalSupabase">>(supabaseUrl: string, supabaseKey: string, options?: SupabaseClientOptions<SchemaName>) => SupabaseClient<Database, SchemaNameOrClientOptions, SchemaName>;
export { Fetch$1 as Fetch, SelfbaseAuthClient as SupabaseAuthClient, Session as AuthSession, User as AuthUser, };
export {};
