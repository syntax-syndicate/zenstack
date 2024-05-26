import {
    DataModel,
    DataModelField,
    Expression,
    Model,
    isDataModel,
    isDataModelField,
    isEnum,
    isMemberAccessExpr,
    isReferenceExpr,
    isThisExpr,
} from '@zenstackhq/language/ast';
import { PolicyCrudKind, type PolicyOperationKind } from '@zenstackhq/runtime';
import {
    ExpressionContext,
    PluginOptions,
    PolicyAnalysisResult,
    RUNTIME_PACKAGE,
    TypeScriptExpressionTransformer,
    analyzePolicies,
    getDataModels,
    hasAttribute,
    hasValidationAttributes,
    isAuthInvocation,
    isForeignKeyField,
} from '@zenstackhq/sdk';
import { getPrismaClientImportSpec } from '@zenstackhq/sdk/prisma';
import { streamAst } from 'langium';
import { lowerCaseFirst } from 'lower-case-first';
import path from 'path';
import { CodeBlockWriter, Project, SourceFile, VariableDeclarationKind, WriterFunction } from 'ts-morph';
import { ConstraintTransformer } from './constraint-transformer';
import {
    generateNormalizedAuthRef,
    generateQueryGuardFunction,
    generateSelectForRules,
    getPolicyExpressions,
    isEnumReferenced,
} from './utils';

/**
 * Generates source file that contains Prisma query guard objects used for injecting database queries
 */
export class PolicyGenerator {
    constructor(private options: PluginOptions) {}

    async generate(project: Project, model: Model, output: string) {
        const sf = project.createSourceFile(path.join(output, 'policy.ts'), undefined, { overwrite: true });
        sf.addStatements('/* eslint-disable */');

        this.writeImports(model, output, sf);

        const models = getDataModels(model);

        sf.addVariableStatement({
            declarationKind: VariableDeclarationKind.Const,
            declarations: [
                {
                    name: 'policy',
                    type: 'PolicyDef',
                    initializer: (writer) => {
                        writer.block(() => {
                            this.writePolicy(writer, models, sf);
                            this.writeValidationMeta(writer, models);
                            this.writeAuthSelector(models, writer);
                        });
                    },
                },
            ],
        });

        sf.addStatements('export default policy');

        // save ts files if requested explicitly or the user provided
        const preserveTsFiles = this.options.preserveTsFiles === true || !!this.options.output;
        if (preserveTsFiles) {
            await sf.save();
        }
    }

    private writeImports(model: Model, output: string, sf: SourceFile) {
        sf.addImportDeclaration({
            namedImports: [
                { name: 'type QueryContext' },
                { name: 'type CrudContract' },
                { name: 'allFieldsEqual' },
                { name: 'type PolicyDef' },
                { name: 'type CheckerContext' },
                { name: 'type CheckerConstraint' },
            ],
            moduleSpecifier: `${RUNTIME_PACKAGE}`,
        });

        // import enums
        const prismaImport = getPrismaClientImportSpec(output, this.options);
        for (const e of model.declarations.filter((d) => isEnum(d) && isEnumReferenced(model, d))) {
            sf.addImportDeclaration({
                namedImports: [{ name: e.name }],
                moduleSpecifier: prismaImport,
            });
        }
    }

    private writePolicy(writer: CodeBlockWriter, models: DataModel[], sourceFile: SourceFile) {
        writer.write('policy:');
        writer.inlineBlock(() => {
            for (const model of models) {
                writer.write(`${lowerCaseFirst(model.name)}:`);

                writer.block(() => {
                    // model-level guards
                    this.writeModelLevelDefs(model, writer, sourceFile);

                    // field-level guards
                    this.writeFieldLevelDefs(model, writer, sourceFile);
                });

                writer.writeLine(',');
            }
        });
        writer.writeLine(',');
    }

    // #region Model-level definitions

    // writes model-level policy def for each operation kind for a model
    // `[modelName]: { [operationKind]: [funcName] },`
    private writeModelLevelDefs(model: DataModel, writer: CodeBlockWriter, sourceFile: SourceFile) {
        const policies = analyzePolicies(model);
        writer.write('modelLevel:');
        writer.inlineBlock(() => {
            this.writeModelReadDef(model, policies, writer, sourceFile);
            this.writeModelCreateDef(model, policies, writer, sourceFile);
            this.writeModelUpdateDef(model, policies, writer, sourceFile);
            this.writeModelPostUpdateDef(model, policies, writer, sourceFile);
            this.writeModelDeleteDef(model, policies, writer, sourceFile);
        });
        writer.writeLine(',');
    }

    // writes `read: ...` for a given model
    private writeModelReadDef(
        model: DataModel,
        policies: PolicyAnalysisResult,
        writer: CodeBlockWriter,
        sourceFile: SourceFile
    ) {
        writer.write(`read:`);
        writer.inlineBlock(() => {
            this.writeCommonModelDef(model, 'read', policies, writer, sourceFile);
        });
        writer.writeLine(',');
    }

    // writes `create: ...` for a given model
    private writeModelCreateDef(
        model: DataModel,
        policies: PolicyAnalysisResult,
        writer: CodeBlockWriter,
        sourceFile: SourceFile
    ) {
        writer.write(`create:`);
        writer.inlineBlock(() => {
            this.writeCommonModelDef(model, 'create', policies, writer, sourceFile);

            // create policy has an additional input checker for validating the payload
            this.writeCreateInputChecker(model, writer, sourceFile);
        });
        writer.writeLine(',');
    }

    // writes `inputChecker: [funcName]` for a given model
    private writeCreateInputChecker(model: DataModel, writer: CodeBlockWriter, sourceFile: SourceFile) {
        const allows = getPolicyExpressions(model, 'allow', 'create');
        const denies = getPolicyExpressions(model, 'deny', 'create');
        if (this.canCheckCreateBasedOnInput(model, allows, denies)) {
            const inputCheckFunc = this.generateCreateInputCheckerFunction(model, allows, denies, sourceFile);
            writer.write(`inputChecker: ${inputCheckFunc.getName()!},`);
        }
    }

    private canCheckCreateBasedOnInput(model: DataModel, allows: Expression[], denies: Expression[]) {
        return [...allows, ...denies].every((rule) => {
            return streamAst(rule).every((expr) => {
                if (isThisExpr(expr)) {
                    return false;
                }
                if (isReferenceExpr(expr)) {
                    if (isDataModel(expr.$resolvedType?.decl)) {
                        // if policy rules uses relation fields,
                        // we can't check based on create input
                        return false;
                    }

                    if (
                        isDataModelField(expr.target.ref) &&
                        expr.target.ref.$container === model &&
                        hasAttribute(expr.target.ref, '@default')
                    ) {
                        // reference to field of current model
                        // if it has default value, we can't check
                        // based on create input
                        return false;
                    }

                    if (isDataModelField(expr.target.ref) && isForeignKeyField(expr.target.ref)) {
                        // reference to foreign key field
                        // we can't check based on create input
                        return false;
                    }
                }

                return true;
            });
        });
    }

    // generates a function for checking "create" input
    private generateCreateInputCheckerFunction(
        model: DataModel,
        allows: Expression[],
        denies: Expression[],
        sourceFile: SourceFile
    ) {
        const statements: (string | WriterFunction)[] = [];

        generateNormalizedAuthRef(model, allows, denies, statements);

        statements.push((writer) => {
            if (allows.length === 0) {
                writer.write('return false;');
                return;
            }

            const transformer = new TypeScriptExpressionTransformer({
                context: ExpressionContext.AccessPolicy,
                fieldReferenceContext: 'input',
            });

            let expr =
                denies.length > 0
                    ? '!(' +
                      denies
                          .map((deny) => {
                              return transformer.transform(deny);
                          })
                          .join(' || ') +
                      ')'
                    : undefined;

            const allowStmt = allows
                .map((allow) => {
                    return transformer.transform(allow);
                })
                .join(' || ');

            expr = expr ? `${expr} && (${allowStmt})` : allowStmt;
            writer.write('return ' + expr);
        });

        const func = sourceFile.addFunction({
            name: model.name + '_create_input',
            returnType: 'boolean',
            parameters: [
                {
                    name: 'input',
                    type: 'any',
                },
                {
                    name: 'context',
                    type: 'QueryContext',
                },
            ],
            statements,
        });

        return func;
    }

    // writes `update: ...` for a given model
    private writeModelUpdateDef(
        model: DataModel,
        policies: PolicyAnalysisResult,
        writer: CodeBlockWriter,
        sourceFile: SourceFile
    ) {
        writer.write(`update:`);
        writer.inlineBlock(() => {
            this.writeCommonModelDef(model, 'update', policies, writer, sourceFile);
        });
        writer.writeLine(',');
    }

    // writes `postUpdate: ...` for a given model
    private writeModelPostUpdateDef(
        model: DataModel,
        policies: PolicyAnalysisResult,
        writer: CodeBlockWriter,
        sourceFile: SourceFile
    ) {
        writer.write(`postUpdate:`);
        writer.inlineBlock(() => {
            this.writeCommonModelDef(model, 'postUpdate', policies, writer, sourceFile);

            // post-update policy has an additional selector for reading the pre-update entity data
            this.writePostUpdatePreValueSelector(model, writer);
        });
        writer.writeLine(',');
    }

    private writePostUpdatePreValueSelector(model: DataModel, writer: CodeBlockWriter) {
        const allows = getPolicyExpressions(model, 'allow', 'postUpdate');
        const denies = getPolicyExpressions(model, 'deny', 'postUpdate');
        const preValueSelect = generateSelectForRules([...allows, ...denies]);
        if (preValueSelect) {
            writer.writeLine(`preUpdateSelector: ${JSON.stringify(preValueSelect)},`);
        }
    }

    // writes `delete: ...` for a given model
    private writeModelDeleteDef(
        model: DataModel,
        policies: PolicyAnalysisResult,
        writer: CodeBlockWriter,
        sourceFile: SourceFile
    ) {
        writer.write(`delete:`);
        writer.inlineBlock(() => {
            this.writeCommonModelDef(model, 'delete', policies, writer, sourceFile);
        });
    }

    // writes `[kind]: ...` for a given model
    private writeCommonModelDef(
        model: DataModel,
        kind: PolicyOperationKind,
        policies: PolicyAnalysisResult,
        writer: CodeBlockWriter,
        sourceFile: SourceFile
    ) {
        const allows = getPolicyExpressions(model, 'allow', kind);
        const denies = getPolicyExpressions(model, 'deny', kind);

        // policy guard
        this.writePolicyGuard(model, kind, policies, allows, denies, writer, sourceFile);

        // permission checker
        if (kind !== 'postUpdate') {
            this.writePermissionChecker(model, kind, policies, allows, denies, writer, sourceFile);
        }
    }

    // writes `guard: ...` for a given policy operation kind
    private writePolicyGuard(
        model: DataModel,
        kind: PolicyOperationKind,
        policies: ReturnType<typeof analyzePolicies>,
        allows: Expression[],
        denies: Expression[],
        writer: CodeBlockWriter,
        sourceFile: SourceFile
    ) {
        if (kind === 'update' && allows.length === 0) {
            // no allow rule for 'update', policy is constant based on if there's
            // post-update counterpart
            if (getPolicyExpressions(model, 'allow', 'postUpdate').length === 0) {
                writer.write(`guard: false,`);
            } else {
                writer.write(`guard: true,`);
            }
            return;
        }

        if (kind === 'postUpdate' && allows.length === 0 && denies.length === 0) {
            // no 'postUpdate' rule, always allow
            writer.write(`guard: true,`);
            return;
        }

        if (kind in policies && typeof policies[kind as keyof typeof policies] === 'boolean') {
            // constant policy
            writer.write(`guard: ${policies[kind as keyof typeof policies]},`);
            return;
        }

        // generate a policy function that evaluates a partial prisma query
        const guardFunc = generateQueryGuardFunction(sourceFile, model, kind, allows, denies);
        writer.write(`guard: ${guardFunc.getName()!},`);
    }

    // writes `permissionChecker: ...` for a given policy operation kind
    private writePermissionChecker(
        model: DataModel,
        kind: PolicyCrudKind,
        policies: PolicyAnalysisResult,
        allows: Expression[],
        denies: Expression[],
        writer: CodeBlockWriter,
        sourceFile: SourceFile
    ) {
        if (this.options.generatePermissionChecker !== true) {
            return;
        }

        if (policies[kind] === true || policies[kind] === false) {
            // constant policy
            writer.write(`permissionChecker: ${policies[kind]},`);
            return;
        }

        if (kind === 'update' && allows.length === 0) {
            // no allow rule for 'update', policy is constant based on if there's
            // post-update counterpart
            if (getPolicyExpressions(model, 'allow', 'postUpdate').length === 0) {
                writer.write(`permissionChecker: false,`);
                return;
            } else {
                writer.write(`permissionChecker: true,`);
                return;
            }
        }

        const guardFunc = this.generatePermissionCheckerFunction(model, kind, allows, denies, sourceFile);
        writer.write(`permissionChecker: ${guardFunc.getName()!},`);
    }

    private generatePermissionCheckerFunction(
        model: DataModel,
        kind: string,
        allows: Expression[],
        denies: Expression[],
        sourceFile: SourceFile
    ) {
        const statements: string[] = [];

        generateNormalizedAuthRef(model, allows, denies, statements);

        const transformed = new ConstraintTransformer({
            authAccessor: 'user',
        }).transformRules(allows, denies);

        statements.push(`return ${transformed};`);

        const func = sourceFile.addFunction({
            name: `${model.name}$checker$${kind}`,
            returnType: 'CheckerConstraint',
            parameters: [
                {
                    name: 'context',
                    type: 'CheckerContext',
                },
            ],
            statements,
        });

        return func;
    }

    // #endregion

    // #region Field-level definitions

    private writeFieldLevelDefs(model: DataModel, writer: CodeBlockWriter, sf: SourceFile) {
        writer.write('fieldLevel:');
        writer.inlineBlock(() => {
            this.writeFieldReadDef(model, writer, sf);
            this.writeFieldUpdateDef(model, writer, sf);
        });
        writer.writeLine(',');
    }

    private writeFieldReadDef(model: DataModel, writer: CodeBlockWriter, sourceFile: SourceFile) {
        const fieldCheckers: Record<string, string> = {};
        const overrideGuards: Record<string, string> = {};
        const allFieldsAllows: Expression[] = [];
        const allFieldsDenies: Expression[] = [];

        // generate field read checkers
        for (const field of model.fields) {
            const allows = getPolicyExpressions(field, 'allow', 'read');
            const denies = getPolicyExpressions(field, 'deny', 'read');
            if (denies.length === 0 && allows.length === 0) {
                continue;
            }

            allFieldsAllows.push(...allows);
            allFieldsDenies.push(...denies);

            const guardFunc = this.generateFieldReadCheckerFunction(sourceFile, field, allows, denies);
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            fieldCheckers[field.name] = guardFunc.getName()!;

            const overrideAllows = getPolicyExpressions(field, 'allow', 'read', true);
            if (overrideAllows.length > 0) {
                const denies = getPolicyExpressions(field, 'deny', 'read');
                const overrideGuardFunc = generateQueryGuardFunction(
                    sourceFile,
                    model,
                    'read',
                    overrideAllows,
                    denies,
                    field,
                    true
                );
                overrideGuards[field.name] = overrideGuardFunc.getName()!;
            }
        }

        if (Object.keys(fieldCheckers).length > 0 || Object.keys(overrideGuards).length > 0) {
            writer.write('read:');
            writer.block(() => {
                if (Object.keys(fieldCheckers).length > 0) {
                    writer.write('checker:');

                    // write checkers
                    writer.inlineBlock(() => {
                        Object.entries(fieldCheckers).forEach(([fieldName, funcName]) => {
                            writer.write(`${fieldName}: ${funcName},`);
                        });
                    });
                    writer.writeLine(',');

                    // write field selector
                    const readFieldCheckSelect = generateSelectForRules([...allFieldsAllows, ...allFieldsDenies]);
                    if (readFieldCheckSelect) {
                        writer.write(`selector: ${JSON.stringify(readFieldCheckSelect)},`);
                    }
                }

                if (Object.keys(overrideGuards).length > 0) {
                    // write override guards
                    writer.write('overrideGuard:');
                    writer.inlineBlock(() => {
                        Object.entries(overrideGuards).forEach(([fieldName, funcName]) => {
                            writer.write(`${fieldName}: ${funcName},`);
                        });
                    });
                    writer.writeLine(',');
                }
            });
            writer.writeLine(',');
        }
    }

    private writeFieldUpdateDef(model: DataModel, writer: CodeBlockWriter, sourceFile: SourceFile) {
        const guards: Record<string, string> = {};
        const overrideGuards: Record<string, string> = {};

        for (const field of model.fields) {
            const allows = getPolicyExpressions(field, 'allow', 'update');
            const denies = getPolicyExpressions(field, 'deny', 'update');

            if (denies.length === 0 && allows.length === 0) {
                continue;
            }

            const guardFunc = generateQueryGuardFunction(sourceFile, model, 'update', allows, denies, field);
            guards[field.name] = guardFunc.getName()!;

            const overrideAllows = getPolicyExpressions(field, 'allow', 'update', true);
            if (overrideAllows.length > 0) {
                const overrideGuardFunc = generateQueryGuardFunction(
                    sourceFile,
                    model,
                    'update',
                    overrideAllows,
                    denies,
                    field,
                    true
                );
                overrideGuards[field.name] = overrideGuardFunc.getName()!;
            }
        }

        if (Object.keys(guards).length > 0 || Object.keys(overrideGuards).length > 0) {
            writer.write('update:');
            writer.block(() => {
                if (Object.keys(guards).length > 0) {
                    writer.write('guard:');
                    writer.inlineBlock(() => {
                        Object.entries(guards).forEach(([fieldName, funcName]) => {
                            writer.write(`${fieldName}: ${funcName},`);
                        });
                    });
                    writer.writeLine(',');
                }

                if (Object.keys(overrideGuards).length > 0) {
                    writer.write('overrideGuard:');
                    writer.inlineBlock(() => {
                        Object.entries(overrideGuards).forEach(([fieldName, funcName]) => {
                            writer.write(`${fieldName}: ${funcName},`);
                        });
                    });
                    writer.writeLine(',');
                }
            });
        }
    }

    private generateFieldReadCheckerFunction(
        sourceFile: SourceFile,
        field: DataModelField,
        allows: Expression[],
        denies: Expression[]
    ) {
        const statements: (string | WriterFunction)[] = [];

        generateNormalizedAuthRef(field.$container as DataModel, allows, denies, statements);

        // compile rules down to typescript expressions
        statements.push((writer) => {
            const transformer = new TypeScriptExpressionTransformer({
                context: ExpressionContext.AccessPolicy,
                fieldReferenceContext: 'input',
            });

            const denyStmt =
                denies.length > 0
                    ? '!(' +
                      denies
                          .map((deny) => {
                              return transformer.transform(deny);
                          })
                          .join(' || ') +
                      ')'
                    : undefined;

            const allowStmt =
                allows.length > 0
                    ? '(' +
                      allows
                          .map((allow) => {
                              return transformer.transform(allow);
                          })
                          .join(' || ') +
                      ')'
                    : undefined;

            let expr: string | undefined;

            if (denyStmt && allowStmt) {
                expr = `${denyStmt} && ${allowStmt}`;
            } else if (denyStmt) {
                expr = denyStmt;
            } else if (allowStmt) {
                expr = allowStmt;
            } else {
                throw new Error('should not happen');
            }

            writer.write('return ' + expr);
        });

        const func = sourceFile.addFunction({
            name: `${field.$container.name}$${field.name}_read`,
            returnType: 'boolean',
            parameters: [
                {
                    name: 'input',
                    type: 'any',
                },
                {
                    name: 'context',
                    type: 'QueryContext',
                },
            ],
            statements,
        });

        return func;
    }

    // #endregion

    //#region Auth selector

    private writeAuthSelector(models: DataModel[], writer: CodeBlockWriter) {
        const authSelector = this.generateAuthSelector(models);
        if (authSelector) {
            writer.write(`authSelector: ${JSON.stringify(authSelector)},`);
        }
    }

    // Generates a { select: ... } object to select `auth()` fields used in policy rules
    private generateAuthSelector(models: DataModel[]) {
        const authRules: Expression[] = [];

        models.forEach((model) => {
            // model-level rules
            const modelPolicyAttrs = model.attributes.filter((attr) =>
                ['@@allow', '@@deny'].includes(attr.decl.$refText)
            );

            // field-level rules
            const fieldPolicyAttrs = model.fields
                .flatMap((f) => f.attributes)
                .filter((attr) => ['@allow', '@deny'].includes(attr.decl.$refText));

            // all rule expression
            const allExpressions = [...modelPolicyAttrs, ...fieldPolicyAttrs]
                .filter((attr) => attr.args.length > 1)
                .map((attr) => attr.args[1].value);

            // collect `auth()` member access
            allExpressions.forEach((rule) => {
                streamAst(rule).forEach((node) => {
                    if (isMemberAccessExpr(node) && isAuthInvocation(node.operand)) {
                        authRules.push(node);
                    }
                });
            });
        });

        if (authRules.length > 0) {
            return generateSelectForRules(authRules, true);
        } else {
            return undefined;
        }
    }

    // #endregion

    // #region Validation meta

    private writeValidationMeta(writer: CodeBlockWriter, models: DataModel[]) {
        writer.write('validation:');
        writer.inlineBlock(() => {
            for (const model of models) {
                writer.write(`${lowerCaseFirst(model.name)}:`);
                writer.inlineBlock(() => {
                    writer.write(`hasValidation: ${hasValidationAttributes(model)}`);
                });
                writer.writeLine(',');
            }
        });
        writer.writeLine(',');
    }

    // #endregion
}
