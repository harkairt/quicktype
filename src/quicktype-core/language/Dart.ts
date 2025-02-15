import {
    Type,
    EnumType,
    UnionType,
    ClassType,
    ClassProperty,
    TransformedStringTypeKind,
    PrimitiveStringTypeKind
} from "../Type";
import { matchType, nullableFromUnion, directlyReachableSingleNamedType } from "../TypeUtils";
import { Sourcelike, maybeAnnotated, modifySource, Source } from "../Source";
import {
    utf16LegalizeCharacters,
    escapeNonPrintableMapper,
    utf16ConcatMap,
    standardUnicodeHexEscape,
    isAscii,
    isLetter,
    isDigit,
    splitIntoWords,
    combineWords,
    allUpperWordStyle,
    firstUpperWordStyle,
    allLowerWordStyle,
    isPrintable,
    decapitalize
} from "../support/Strings";

import { StringTypeMapping } from "../TypeBuilder";

import { Name, Namer, funPrefixNamer, DependencyName } from "../Naming";
import { ConvenienceRenderer, ForbiddenWordsInfo } from "../ConvenienceRenderer";
import { TargetLanguage } from "../TargetLanguage";
import { Option, BooleanOption, getOptionValues, OptionValues, StringOption } from "../RendererOptions";
import { anyTypeIssueAnnotation, nullTypeIssueAnnotation } from "../Annotation";
import { defined } from "../support/Support";
import { RenderContext } from "../Renderer";
import { arrayIntercalate } from "collection-utils";
import { snakeCase } from "lodash";

export const dartOptions = {
    justTypes: new BooleanOption("just-types", "Types only", false),
    codersInClass: new BooleanOption("coders-in-class", "Put encoder & decoder in Class", false),
    methodNamesWithMap: new BooleanOption("from-map", "Use method names fromMap() & toMap()", false),
    requiredProperties: new BooleanOption("required-props", "Make all properties required", false),
    finalProperties: new BooleanOption("final-props", "Make all properties final", false),
    generateCopyWith: new BooleanOption("copy-with", "Generate CopyWith method", false),
    useFreezed: new BooleanOption("use-freezed", "Generate class definitions with @freezed compatibility", false),
    partName: new StringOption("part-name", "Use this name in `part` directive", "NAME", ""),
};

export class DartTargetLanguage extends TargetLanguage {
    constructor() {
        super("Dart", ["dart"], "dart");
    }

    protected getOptions(): Option<any>[] {
        return [
            dartOptions.justTypes,
            dartOptions.codersInClass,
            dartOptions.methodNamesWithMap,
            dartOptions.requiredProperties,
            dartOptions.finalProperties,
            dartOptions.generateCopyWith,
            dartOptions.useFreezed,
            dartOptions.partName,
        ];
    }

    get supportsUnionsWithBothNumberTypes(): boolean {
        return true;
    }

    get stringTypeMapping(): StringTypeMapping {
        const mapping: Map<TransformedStringTypeKind, PrimitiveStringTypeKind> = new Map();
        mapping.set("date", "date");
        mapping.set("date-time", "date-time");
        //        mapping.set("uuid", "uuid");
        return mapping;
    }

    protected makeRenderer(renderContext: RenderContext, untypedOptionValues: { [name: string]: any }): DartRenderer {
        const options = getOptionValues(dartOptions, untypedOptionValues);
        return new DartRenderer(this, renderContext, options);
    }
}

const keywords = [
    "abstract",
    "do",
    "import",
    "super",
    "as",
    "dynamic",
    "in",
    "switch",
    "assert",
    "else",
    "interface",
    "sync*",
    "async",
    "enum",
    "is",
    "this",
    "async*",
    "export",
    "library",
    "throw",
    "await",
    "external",
    "mixin",
    "true",
    "break",
    "extends",
    "new",
    "try",
    "case",
    "factory",
    "null",
    "typedef",
    "catch",
    "false",
    "operator",
    "var",
    "class",
    "final",
    "part",
    "void",
    "const",
    "finally",
    "rethrow",
    "while",
    "continue",
    "for",
    "return",
    "with",
    "covariant",
    "get",
    "set",
    "yield",
    "default",
    "if",
    "static",
    "yield*",
    "deferred",
    "implements",
    "int",
    "double",
    "bool",
    "Map",
    "List",
    "String",
    "File",
    "fromJson",
    "toJson",
    "fromMap",
    "toMap"
];

const typeNamingFunction = funPrefixNamer("types", n => dartNameStyle(true, false, n));
const propertyNamingFunction = funPrefixNamer("properties", n => dartNameStyle(false, false, n));
const enumCaseNamingFunction = funPrefixNamer("enum-cases", n => dartNameStyle(true, true, n));

// Escape the dollar sign, which is used in string interpolation
const stringEscape = utf16ConcatMap(
    escapeNonPrintableMapper(cp => isPrintable(cp) && cp !== 0x24, standardUnicodeHexEscape)
);

function isStartCharacter(codePoint: number): boolean {
    if (codePoint === 0x5f) return false; // underscore
    return isAscii(codePoint) && isLetter(codePoint);
}

function isPartCharacter(codePoint: number): boolean {
    return isStartCharacter(codePoint) || (isAscii(codePoint) && isDigit(codePoint));
}

const legalizeName = utf16LegalizeCharacters(isPartCharacter);

// FIXME: Handle acronyms consistently.  In particular, that means that
// we have to use namers to produce the getter and setter names - we can't
// just capitalize and concatenate.
// https://stackoverflow.com/questions/8277355/naming-convention-for-upper-case-abbreviations
function dartNameStyle(startWithUpper: boolean, upperUnderscore: boolean, original: string): string {
    const words = splitIntoWords(original);
    const firstWordStyle = upperUnderscore
        ? allUpperWordStyle
        : startWithUpper
            ? firstUpperWordStyle
            : allLowerWordStyle;
    const restWordStyle = upperUnderscore ? allUpperWordStyle : firstUpperWordStyle;
    return combineWords(
        words,
        legalizeName,
        firstWordStyle,
        restWordStyle,
        firstWordStyle,
        restWordStyle,
        upperUnderscore ? "_" : "",
        isStartCharacter
    );
}

type TopLevelDependents = {
    encoder: Name;
    decoder: Name;
};

export class DartRenderer extends ConvenienceRenderer {
    private readonly _gettersAndSettersForPropertyName = new Map<Name, [Name, Name]>();
    private _needEnumValues = false;
    private readonly _topLevelDependents = new Map<Name, TopLevelDependents>();
    private readonly _enumValues = new Map<EnumType, Name>();

    constructor(
        targetLanguage: TargetLanguage,
        renderContext: RenderContext,
        private readonly _options: OptionValues<typeof dartOptions>
    ) {
        super(targetLanguage, renderContext);
    }

    protected forbiddenNamesForGlobalNamespace(): string[] {
        return keywords;
    }

    protected forbiddenForObjectProperties(_c: ClassType, _className: Name): ForbiddenWordsInfo {
        return { names: [], includeGlobalForbidden: true };
    }

    protected makeNamedTypeNamer(): Namer {
        return typeNamingFunction;
    }

    protected namerForObjectProperty(): Namer {
        return propertyNamingFunction;
    }

    protected makeUnionMemberNamer(): Namer {
        return propertyNamingFunction;
    }

    protected makeEnumCaseNamer(): Namer {
        return enumCaseNamingFunction;
    }

    protected unionNeedsName(u: UnionType): boolean {
        return nullableFromUnion(u) === null;
    }

    protected namedTypeToNameForTopLevel(type: Type): Type | undefined {
        // If the top-level type doesn't contain any classes or unions
        // we have to define a class just for the `FromJson` method, in
        // emitFromJsonForTopLevel.
        return directlyReachableSingleNamedType(type);
    }

    protected get toJson(): string {
        return `to${this._options.methodNamesWithMap ? "Map" : "Json"}`;
    }

    protected get fromJson(): string {
        return `from${this._options.methodNamesWithMap ? "Map" : "Json"}`;
    }

    protected makeTopLevelDependencyNames(_t: Type, name: Name): DependencyName[] {
        const encoder = new DependencyName(
            propertyNamingFunction,
            name.order,
            lookup => `${lookup(name)}_${this.toJson}`
        );
        const decoder = new DependencyName(
            propertyNamingFunction,
            name.order,
            lookup => `${lookup(name)}_${this.fromJson}`
        );
        this._topLevelDependents.set(name, { encoder, decoder });
        return [encoder, decoder];
    }

    protected makeNamesForPropertyGetterAndSetter(
        _c: ClassType,
        _className: Name,
        _p: ClassProperty,
        _jsonName: string,
        name: Name
    ): [Name, Name] {
        const getterName = new DependencyName(propertyNamingFunction, name.order, lookup => `get_${lookup(name)}`);
        const setterName = new DependencyName(propertyNamingFunction, name.order, lookup => `set_${lookup(name)}`);
        return [getterName, setterName];
    }

    protected makePropertyDependencyNames(
        c: ClassType,
        className: Name,
        p: ClassProperty,
        jsonName: string,
        name: Name
    ): Name[] {
        const getterAndSetterNames = this.makeNamesForPropertyGetterAndSetter(c, className, p, jsonName, name);
        this._gettersAndSettersForPropertyName.set(name, getterAndSetterNames);
        return getterAndSetterNames;
    }

    protected makeNamedTypeDependencyNames(t: Type, name: Name): DependencyName[] {
        if (!(t instanceof EnumType)) return [];
        const enumValue = new DependencyName(propertyNamingFunction, name.order, lookup => `${lookup(name)}_values`);
        this._enumValues.set(t, enumValue);
        return [enumValue];
    }

    protected emitFileHeader(): void {
        if (this.leadingComments !== undefined) {
            this.emitCommentLines(this.leadingComments);
        }

        if (this._options.justTypes) return;

        this.emitLine("// To parse this JSON data, do");
        this.emitLine("//");
        this.forEachTopLevel("none", (_t, name) => {
            const { decoder } = defined(this._topLevelDependents.get(name));
            this.emitLine("//     final ", modifySource(decapitalize, name), " = ", decoder, "(jsonString);");
        });

        this.ensureBlankLine();
        if (this._options.requiredProperties) {
            this.emitLine("import 'package:meta/meta.dart';");
        }
        if (this._options.useFreezed) {
            this.emitLine("import 'package:freezed_annotation/freezed_annotation.dart';");
        }
        this.emitLine("import 'dart:convert';");
        if (this._options.useFreezed) {
            this.ensureBlankLine();
            const optionNameIsEmpty = this._options.partName.length === 0;
            const name = modifySource(snakeCase, optionNameIsEmpty ? [...this.topLevels.keys()][0] : this._options.partName);
            this.emitLine("part '", name, ".freezed.dart';");
            if (!this._options.justTypes) {
                this.emitLine("part '", name, ".g.dart';");
            }
        }
    }

    protected emitDescriptionBlock(lines: Sourcelike[]): void {
        this.emitCommentLines(lines, " * ", "/**", " */");
    }

    protected emitBlock(line: Sourcelike, f: () => void): void {
        this.emitLine(line, " {");
        this.indent(f);
        this.emitLine("}");
    }

    protected dartType(t: Type, withIssues: boolean = false): Sourcelike {
        return matchType<Sourcelike>(
            t,
            _anyType => maybeAnnotated(withIssues, anyTypeIssueAnnotation, "dynamic"),
            _nullType => maybeAnnotated(withIssues, nullTypeIssueAnnotation, "dynamic"),
            _boolType => "bool",
            _integerType => "int",
            _doubleType => "double",
            _stringType => "String",
            arrayType => ["List<", this.dartType(arrayType.items, withIssues), ">"],
            classType => this.nameForNamedType(classType),
            mapType => ["Map<String, ", this.dartType(mapType.values, withIssues), ">"],
            enumType => this.nameForNamedType(enumType),
            unionType => {
                const maybeNullable = nullableFromUnion(unionType);
                if (maybeNullable === null) {
                    return "dynamic";
                }
                return this.dartType(maybeNullable, withIssues);
            },
            transformedStringType => {
                switch (transformedStringType.kind) {
                    case "date-time":
                    case "date":
                        return "DateTime";
                    default:
                        return "String";
                }
            }
        );
    }

    protected dartTypeGen(t: Type, withIssues: boolean = false): Sourcelike {
        return matchType<Sourcelike>(
            t,
            _anyType => maybeAnnotated(withIssues, anyTypeIssueAnnotation, "dynamic"),
            _nullType => maybeAnnotated(withIssues, nullTypeIssueAnnotation, "dynamic"),
            _boolType => "bool",
            _integerType => "int",
            _doubleType => "double",
            _stringType => "String",
            _arrayType => "List<dynamic>",
            _classType => "Map<String, dynamic>",
            _mapType => "Map<String, dynamic>",
            enumType => this.nameForNamedType(enumType),
            unionType => {
                const maybeNullable = nullableFromUnion(unionType);
                if (maybeNullable === null) {
                    return "dynamic";
                }
                return this.dartType(maybeNullable, withIssues);
            },
            transformedStringType => {
                switch (transformedStringType.kind) {
                    case "date-time":
                    case "date":
                        return "DateTime";
                    default:
                        return "String";
                }
            }
        );
    }

    protected isCompositeCollection(t: Type): boolean {
        return matchType<boolean>(
            t,
            _anyType => false,
            _nullType => false,
            _boolType => false,
            _integerType => false,
            _doubleType => false,
            _stringType => false,
            arrayType => {
                const holdsClassType = this.isClassType(arrayType.items)
                return holdsClassType;
            },
            _classType => true,
            mapType => {
                const holdsClassType = this.isClassType(mapType.values)
                return holdsClassType;
            },
            _enumType => false,
            _unionType => false,
            _transformedStringType => false
        );
    }

    protected isClassType(t: Type): boolean {
        return matchType<boolean>(
            t,
            _anyType => false,
            _nullType => false,
            _boolType => false,
            _integerType => false,
            _doubleType => false,
            _stringType => false,
            _arrayType => false,
            _classType => true,
            _mapType => false,
            _enumType => false,
            _unionType => false,
            _transformedStringType => false
        );
    }

    protected isEnumType(t: Type): boolean {
        return matchType<boolean>(
            t,
            _anyType => false,
            _nullType => false,
            _boolType => false,
            _integerType => false,
            _doubleType => false,
            _stringType => false,
            _arrayType => false,
            _classType => false,
            _mapType => false,
            _enumType => true,
            _unionType => true,
            _transformedStringType => false
        );
    }
    protected isUnionType(t: Type): boolean {
        return matchType<boolean>(
            t,
            _anyType => false,
            _nullType => false,
            _boolType => false,
            _integerType => false,
            _doubleType => false,
            _stringType => false,
            _arrayType => false,
            _classType => false,
            _mapType => false,
            _enumType => false,
            _unionType => true,
            _transformedStringType => false
        );
    }
    protected isDoubleType(t: Type): boolean {
        return matchType<boolean>(
            t,
            _anyType => false,
            _nullType => false,
            _boolType => false,
            _integerType => false,
            _doubleType => true,
            _stringType => false,
            _arrayType => false,
            _classType => false,
            _mapType => false,
            _enumType => false,
            _unionType => false,
            _transformedStringType => false
        );
    }

    protected isPrimitiveType(t: Type): boolean {
        return matchType<boolean>(
            t,
            _anyType => false,
            _nullType => false,
            _boolType => true,
            _integerType => true,
            _doubleType => true,
            _stringType => true,
            _arrayType => false,
            _classType => false,
            _mapType => false,
            _enumType => false,
            _unionType => true,
            _transformedStringType => false
        );
    }

    protected toMapList(itemType: Sourcelike, list: Sourcelike, mapper: Sourcelike): Sourcelike {
        return ["List<", itemType, ">.from(", list, ".map<dynamic>((x) => ", mapper, "))"];
    }
    protected toMapMap(valueType: Sourcelike, map: Sourcelike, valueMapper: Sourcelike): Sourcelike {
        return ["Map<String, dynamic>.from(", map, ").map<String, dynamic>((k, dynamic v) => MapEntry<String, ", valueType, ">(k, ", valueMapper, "))"];
    }


    protected fromMapList(itemType: Sourcelike, list: Sourcelike, castAsGeneric: boolean = false): Sourcelike {
        return ["List<", itemType, ">.from(", list, castAsGeneric ? " as List<dynamic>)" : ")"];
    }

    protected fromMapCompositeList(itemType: Sourcelike, list: Sourcelike, casting: Sourcelike): Sourcelike {
        return ["List<", itemType, ">.from((", list, ")", casting, ")"];
    }

    protected fromMapCompositeMap(itemType: Sourcelike, list: Sourcelike, casting: Sourcelike, innerCasting: Sourcelike): Sourcelike {
        return ["Map<String, dynamic>.from(", list, innerCasting, ")", casting, ")"];
    }

    protected fromMapMap(valueType: Sourcelike, map: Sourcelike, castAsGeneric: boolean = false): Sourcelike {
        return ["Map<String, ", valueType, ">.from(", map, castAsGeneric ? " as Map<String, dynamic>)" : ")"];
    }

    protected fromDynamicExpression(t: Type, castAsGeneric: boolean = false, ...dynamic: Sourcelike[]): Sourcelike {
        return matchType<Sourcelike>(
            t,
            _anyType => dynamic,
            _nullType => dynamic, // FIXME: check null
            _boolType => dynamic,
            _integerType => dynamic,
            _doubleType => dynamic,
            _stringType => dynamic,
            arrayType => {
                const isCompoositeCollectioh = this.isCompositeCollection(arrayType);
                if (isCompoositeCollectioh) {
                    const typeString = this.dartType(arrayType.items);
                    const casting: Sourcelike = [
                        ".cast<Map<String, dynamic>>().map<", typeString, ">((x) => ", typeString, ".fromJson(x))"]
                    return this.fromMapCompositeList(this.dartType(arrayType.items), dynamic, casting);
                } else {
                    return this.fromMapList(this.dartType(arrayType.items), dynamic, castAsGeneric);
                }
            },
            classType => {
                const castString: Sourcelike = castAsGeneric ? [" as Map<String, dynamic>"] : ""
                return [this.nameForNamedType(classType), ".", this.fromJson, "(", dynamic, castString, ")"];
            },
            mapType => {
                const isCompoositeCollectioh = this.isCompositeCollection(mapType);
                if (isCompoositeCollectioh) {
                    const typeString = this.dartType(mapType.values);
                    const casting: Sourcelike = [
                        ".cast<String, Map<String, dynamic>>().map((key, value) => MapEntry(key, ", typeString, ".fromJson(value))"]
                    const castString: Sourcelike = castAsGeneric ? [" as Map<String, dynamic>"] : ""

                    return this.fromMapCompositeMap(this.dartType(mapType.values), dynamic, casting, castString);
                } else {
                    return this.fromMapMap(this.dartType(mapType.values), dynamic, castAsGeneric);
                }
            },
            enumType => [defined(this._enumValues.get(enumType)), ".map[", dynamic, "]"],
            unionType => {
                const maybeNullable = nullableFromUnion(unionType);
                if (maybeNullable === null) {
                    return [dynamic];
                }
                const needsCasting = this.isPrimitiveType(maybeNullable)
                const castString: Sourcelike = needsCasting ? [" as ", this.dartType(maybeNullable)] : ""
                return [dynamic, " == null ? null : ", this.fromDynamicExpression(maybeNullable, true, dynamic), castString];
            },
            transformedStringType => {
                switch (transformedStringType.kind) {
                    case "date-time":
                    case "date":
                        return ["DateTime.parse(", dynamic, ")"];
                    default:
                        return dynamic;
                }
            }
        );
    }

    protected toDynamicExpression(t: Type, ...dynamic: Sourcelike[]): Sourcelike {
        return matchType<Sourcelike>(
            t,
            _anyType => dynamic,
            _nullType => dynamic,
            _boolType => dynamic,
            _integerType => dynamic,
            _doubleType => dynamic,
            _stringType => dynamic,
            arrayType => this.toMapList("dynamic", dynamic, this.toDynamicExpression(arrayType.items, "x")),
            _classType => [dynamic, ".", this.toJson, "()"],
            mapType => this.toMapMap("dynamic", dynamic, this.toDynamicExpression(mapType.values, "v")),
            enumType => [defined(this._enumValues.get(enumType)), ".reverse[", dynamic, "]"],
            unionType => {
                const maybeNullable = nullableFromUnion(unionType);
                if (maybeNullable === null) {
                    return dynamic;
                }
                return [dynamic, " == null ? null : ", this.toDynamicExpression(maybeNullable, dynamic)];
            },
            transformedStringType => {
                switch (transformedStringType.kind) {
                    case "date-time":
                        return [dynamic, ".toIso8601String()"];
                    case "date":
                        return [
                            '"${',
                            dynamic,
                            ".year.toString().padLeft(4, '0')",
                            "}-${",
                            dynamic,
                            ".month.toString().padLeft(2, '0')}-${",
                            dynamic,
                            ".day.toString().padLeft(2, '0')}\""
                        ];
                    default:
                        return dynamic;
                }
            }
        );
    }

    protected emitClassDefinition(c: ClassType, className: Name): void {
        this.emitDescription(this.descriptionForType(c));
        this.emitBlock(["class ", className], () => {
            if (c.getProperties().size === 0) {
                this.emitLine(className, "();");
            } else {
                this.emitLine(className, "({");
                this.indent(() => {
                    this.forEachClassProperty(c, "none", (name, _, _p) => {
                        this.emitLine(this._options.requiredProperties ? "@required " : "", "this.", name, ",");
                    });
                });
                this.emitLine("});");
                this.ensureBlankLine();

                this.forEachClassProperty(c, "none", (name, _, p) => {
                    this.emitLine(
                        this._options.finalProperties ? "final " : "",
                        this.dartType(p.type, true),
                        " ",
                        name,
                        ";"
                    );
                });
            }

            if (this._options.generateCopyWith) {
                this.ensureBlankLine();
                this.emitLine(className, " copyWith({");
                this.indent(() => {
                    this.forEachClassProperty(c, "none", (name, _, _p) => {
                        this.emitLine(this.dartType(_p.type, true), " ", name, ",");
                    });
                });
                this.emitLine("}) => ");
                this.indent(() => {
                    this.emitLine(className, "(");
                    this.indent(() => {
                        this.forEachClassProperty(c, "none", (name, _, _p) => {
                            this.emitLine(name, ": ", name, " ?? ", "this.", name, ",");
                        });
                    });
                    this.emitLine(");");
                });
            }

            if (this._options.justTypes) return;

            if (this._options.codersInClass) {
                this.ensureBlankLine();
                this.emitLine(
                    "factory ",
                    className,
                    ".from",
                    this._options.methodNamesWithMap ? "Json" : "RawJson",
                    "(String str) => ",
                    className,
                    ".",
                    this.fromJson,
                    "(json.decode(str) as Map<String, dynamic>);"
                );

                this.ensureBlankLine();
                this.emitLine(
                    "String ",
                    this._options.methodNamesWithMap ? "toJson() => " : "toRawJson() => ",
                    "json.encode(",
                    this.toJson,
                    "());"
                );
            }

            this.ensureBlankLine();
            this.emitLine("factory ", className, ".", this.fromJson, "(Map<String, dynamic> json) => ", className, "(");
            this.indent(() => {
                this.forEachClassProperty(c, "none", (name, jsonName, property) => {
                    const needsCasting = !this.isEnumType(property.type) && !this.isUnionType(property.type)
                    const castString = needsCasting ? [' as ', this.dartTypeGen(property.type)] : ''

                    const isDouble = this.isDoubleType(property.type)
                    if (isDouble) {
                        this.emitLine(
                            name,
                            ": ",
                            this.fromDynamicExpression(property.type, false, '(json["', stringEscape(jsonName), '"] as num).toDouble()'),
                            ","
                        );
                    } else {
                        this.emitLine(
                            name,
                            ": ",
                            this.fromDynamicExpression(property.type, false, 'json["', stringEscape(jsonName), '"]', castString),
                            ","
                        );
                    }
                });
            });
            this.emitLine(");");

            this.ensureBlankLine();

            this.emitLine("Map<String, dynamic> ", this.toJson, "() => <String, dynamic>{");
            this.indent(() => {
                this.forEachClassProperty(c, "none", (name, jsonName, property) => {
                    this.emitLine(
                        '"',
                        stringEscape(jsonName),
                        '": ',
                        this.toDynamicExpression(property.type, name),
                        ","
                    );
                });
            });
            this.emitLine("};");
        });
    }

    protected emitFreezedClassDefinition(c: ClassType, className: Name): void {
        this.emitDescription(this.descriptionForType(c));

        this.emitLine("@freezed");
        this.emitBlock(["abstract class ", className, " with _$", className], () => {
            if (c.getProperties().size === 0) {
                this.emitLine("const factory ", className, "() = _", className, ";");
            } else {
                this.emitLine("const factory ", className, "({");
                this.indent(() => {
                    this.forEachClassProperty(c, "none", (name, _, _p) => {
                        this.emitLine(this._options.requiredProperties ? "@required " : "", this.dartType(_p.type, true), " ", name, ",");
                    });
                });
                this.emitLine("}) = _", className, ";");
            }

            if (this._options.justTypes) return;

            this.ensureBlankLine();
            this.emitLine(
                // factory PublicAnswer.fromJson(Map<String, dynamic> json) => _$PublicAnswerFromJson(json);
                "factory ",
                className,
                ".fromJson(Map<String, dynamic> json) => ",
                "_$",
                className,
                "FromJson(json);",
            );
        });
    }

    protected emitEnumDefinition(e: EnumType, enumName: Name): void {
        const caseNames: Sourcelike[] = Array.from(e.cases).map(c => this.nameForEnumCase(e, c));
        this.emitDescription(this.descriptionForType(e));
        this.emitLine("enum ", enumName, " { ", arrayIntercalate(", ", caseNames), " }");

        if (this._options.justTypes) return;

        this.ensureBlankLine();
        this.emitLine("final ", defined(this._enumValues.get(e)), " = EnumValues({");
        this.indent(() => {
            this.forEachEnumCase(e, "none", (name, jsonName, pos) => {
                const comma = pos === "first" || pos === "middle" ? "," : [];
                this.emitLine('"', stringEscape(jsonName), '": ', enumName, ".", name, comma);
            });
        });
        this.emitLine("});");

        this._needEnumValues = true;
    }

    protected emitEnumValues(): void {
        this.ensureBlankLine();
        this.emitMultiline(`class EnumValues<T> {
    Map<String, T> map;
    Map<T, String> reverseMap;

    EnumValues(this.map);

    Map<T, String> get reverse {
        if (reverseMap == null) {
            reverseMap = map.map((k, v) => new MapEntry(v, k));
        }
        return reverseMap;
    }
}`);
    }

    protected emitSourceStructure(): void {
        this.emitFileHeader();

        if (!this._options.justTypes && !this._options.codersInClass) {
            this.forEachTopLevel("leading-and-interposing", (t, name) => {
                const { encoder, decoder } = defined(this._topLevelDependents.get(name));

                // this.emitLine(
                //     this.dartType(t),
                //     " ",
                //     mapper,
                //     "(Map<String, dynamic> map) => ",
                //     this.fromDynamicExpression(t, "map"),
                //     ";"
                // );

                this.ensureBlankLine();

                this.emitLine(
                    this.dartType(t),
                    " ",
                    decoder,
                    "(String str) => ",
                    this.fromDynamicExpression(t, false, "json.decode(str) as Map<String, dynamic>"),
                    ";"
                );

                this.ensureBlankLine();

                this.emitLine(
                    "String ",
                    encoder,
                    "(",
                    this.dartType(t),
                    " data) => json.encode(",
                    this.toDynamicExpression(t, "data"),
                    ");"
                );

                // this.emitBlock(["String ", encoder, "(", this.dartType(t), " data)"], () => {
                //     this.emitJsonEncoderBlock(t);
                // });
            });
        }

        this.forEachNamedType(
            "leading-and-interposing",
            (c: ClassType, n: Name) => this._options.useFreezed ? this.emitFreezedClassDefinition(c, n) : this.emitClassDefinition(c, n),
            (e, n) => this.emitEnumDefinition(e, n),
            (_e, _n) => {
                // We don't support this yet.
            }
        );

        if (this._needEnumValues) {
            this.emitEnumValues();
        }
    }
}
