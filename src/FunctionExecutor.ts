/* eslint-disable @typescript-eslint/naming-convention */
import type { SourceParser } from './input-parser/SourceParser';
import type { MappingProcessor } from './MappingProcessor';
import { predefinedFunctions } from './PredefinedFunctions';
import { returnFirstItemInArrayOrValue, addArray } from './util/ArrayUtil';
import {
  getIdFromNodeObjectIfDefined,
  getValue,
  getConstant,
  getPredicateValueFromPredicateObjectMap,
  getFunctionNameFromPredicateObjectMap,
  isFnoExecutesPredicate,
  predicateContainsFnoExecutes,
  addToObj,
} from './util/ObjectUtil';
import type {
  FnoFunctionParameter,
  FunctionValue,
  ObjectMap,
  OrArray,
  PredicateObjectMap,
  ReferenceNodeObject,
  TriplesMap,
  ValueObject,
} from './util/Types';
import { FNML, RML, RR } from './util/Vocabulary';

type FnoFunction = (parameters: any) => Promise<any> | any;

const templateRegex = /(?:\{(.*?)\})/ug;

interface FunctionExecutorArgs {
  parser: SourceParser<any>;
  functions?: Record<string, FnoFunction>;
}

export class FunctionExecutor {
  private readonly parser: SourceParser<any>;
  private readonly functions?: Record<string, FnoFunction>;

  public constructor(args: FunctionExecutorArgs) {
    this.functions = args.functions;
    this.parser = args.parser;
  }

  public async executeFunctionFromValue(
    functionValue: FunctionValue,
    index: number,
    topLevelMappingProcessors: Record<string, MappingProcessor>,
    applyFiltering = true,
  ): Promise<any> {
    const functionName = await this.getFunctionName(
      functionValue[RR.predicateObjectMap],
      index,
      topLevelMappingProcessors,
      applyFiltering,
    );
    const parameters = await this.getFunctionParameters(
      functionValue[RR.predicateObjectMap],
      index,
      topLevelMappingProcessors,
      applyFiltering,
    );
    const params = await this.calculateFunctionParams(parameters, index, topLevelMappingProcessors, applyFiltering);
    return await this.executeFunction(functionName, params);
  }

  private async getFunctionName(
    predicateObjectMapField: OrArray<Record<string, any>>,
    index: number,
    topLevelMappingProcessors: Record<string, MappingProcessor>,
    applyFiltering: boolean,
  ): Promise<string> {
    const predicateObjectMaps = addArray(predicateObjectMapField) as PredicateObjectMap[];
    for (const predicateObjectMap of predicateObjectMaps) {
      const predicate = await getPredicateValueFromPredicateObjectMap(
        predicateObjectMap,
        index,
        topLevelMappingProcessors,
        this.parser,
        this,
        applyFiltering,
      );
      if (predicateContainsFnoExecutes(predicate)) {
        const functionName = getFunctionNameFromPredicateObjectMap(predicateObjectMap);
        if (functionName) {
          return functionName;
        }
      }
    }
    throw new Error('Failed to find function name in predicatePbjectMap');
  }

  private async getFunctionParameters(
    predicateObjectMapField: OrArray<PredicateObjectMap>,
    index: number,
    topLevelMappingProcessors: Record<string, MappingProcessor>,
    applyFiltering: boolean,
  ): Promise<FnoFunctionParameter[]> {
    if (Array.isArray(predicateObjectMapField)) {
      return await this.getParametersFromPredicateObjectMaps(
        predicateObjectMapField,
        index,
        topLevelMappingProcessors,
        applyFiltering,
      );
    }
    return await this.getParametersFromPredicateObjectMap(
      predicateObjectMapField,
      index,
      topLevelMappingProcessors,
      applyFiltering,
    );
  }

  private async getParametersFromPredicateObjectMaps(
    predicateObjectMaps: PredicateObjectMap[],
    index: number,
    topLevelMappingProcessors: Record<string, MappingProcessor>,
    applyFiltering: boolean,
  ): Promise<FnoFunctionParameter[]> {
    let parameters: FnoFunctionParameter[] = [];
    for (const predicateObjectMap of predicateObjectMaps) {
      const thisMapParameters = await this.getParametersFromPredicateObjectMap(
        predicateObjectMap,
        index,
        topLevelMappingProcessors,
        applyFiltering,
      );
      parameters = [ ...parameters, ...thisMapParameters ];
    }
    return parameters;
  }

  private async getParametersFromPredicateObjectMap(
    predicateObjectMap: PredicateObjectMap,
    index: number,
    topLevelMappingProcessors: Record<string, MappingProcessor>,
    applyFiltering: boolean,
  ): Promise<FnoFunctionParameter[]> {
    const predicate = await getPredicateValueFromPredicateObjectMap(
      predicateObjectMap,
      index,
      topLevelMappingProcessors,
      this.parser,
      this,
      applyFiltering,
    ) as string;
    if (!isFnoExecutesPredicate(predicate)) {
      const { [RR.object]: object, [RR.objectMap]: objectMap } = predicateObjectMap;
      if (object) {
        return this.getParametersFromObject(object, predicate);
      }
      if (objectMap) {
        return this.getParametersFromObjectMap(objectMap, predicate);
      }
    }
    return [];
  }

  private getParametersFromObject(object: OrArray<ReferenceNodeObject>, predicate: string): FnoFunctionParameter[] {
    if (Array.isArray(object)) {
      const objectMapsFromObject = object.map((objectItem): ObjectMap =>
        ({ '@type': RR.ObjectMap, [RR.constant]: objectItem }));
      return this.getParametersFromObjectMap(objectMapsFromObject, predicate);
    }
    const objectMapFromObject = { '@type': RR.ObjectMap, [RR.constant]: object };
    return this.getParametersFromObjectMap(objectMapFromObject, predicate);
  }

  private getParametersFromObjectMap(objectMap: OrArray<ObjectMap>, predicate: string): FnoFunctionParameter[] {
    if (Array.isArray(objectMap)) {
      return objectMap.map((objectMapItem: ObjectMap): FnoFunctionParameter =>
        ({ [RR.predicate]: { '@id': predicate }, ...objectMapItem }));
    }
    return [{
      [RR.predicate]: { '@id': predicate },
      ...objectMap,
    }];
  }

  private async calculateFunctionParams(
    parameters: FnoFunctionParameter[],
    index: number,
    topLevelMappingProcessors: Record<string, MappingProcessor>,
    applyFiltering: boolean,
  ): Promise<Record<string | number, any>> {
    const result: Record<string | number, any> = [];
    await Promise.all(
      parameters.map(async(parameter): Promise<void> => {
        // Adds parameters both by their predicates and as array values
        const value = await this.getParameterValue(parameter, index, topLevelMappingProcessors, applyFiltering);
        addToObj(result, parameter[RR.predicate]['@id'], value);
        result.push(value);
      }),
    );
    return result;
  }

  private async getParameterValue(
    parameter: FnoFunctionParameter,
    index: number,
    topLevelMappingProcessors: Record<string, MappingProcessor>,
    applyFiltering: boolean,
  ): Promise<any> {
    if (RR.constant in parameter) {
      return getConstant(parameter[RR.constant]);
    }
    if (RML.reference in parameter) {
      return this.getValueOfReference(parameter[RML.reference]!, index, parameter[RR.datatype], applyFiltering);
    }
    if (RR.template in parameter) {
      return this.resolveTemplate(parameter[RR.template]!, index, applyFiltering);
    }
    if (FNML.functionValue in parameter) {
      return await this.resolveFunctionValue(
        parameter[FNML.functionValue]!,
        index,
        topLevelMappingProcessors,
        applyFiltering,
      );
    }
    if (RR.parentTriplesMap in parameter) {
      return await this.resolveTriplesMap(parameter[RR.parentTriplesMap]!, topLevelMappingProcessors);
    }
  }

  private getValueOfReference(
    reference: string | ValueObject<string>,
    index: number,
    datatype: string | ReferenceNodeObject | undefined,
    applyFiltering: boolean,
  ): OrArray<any> {
    const data = this.parser.getData(
      index,
      getValue<string>(reference),
      getIdFromNodeObjectIfDefined(datatype),
      applyFiltering,
    );
    return returnFirstItemInArrayOrValue(data);
  }

  private resolveTemplate(template: string | ValueObject<string>, index: number, applyFiltering: boolean): string {
    let resolvedTemplate = getValue<string>(template);
    let match = templateRegex.exec(resolvedTemplate);
    while (match) {
      const variableValue = this.parser.getData(index, match[1], undefined, applyFiltering);
      resolvedTemplate = resolvedTemplate.replace(`{${match[1]}}`, variableValue.toString());
      match = templateRegex.exec(resolvedTemplate);
    }
    return resolvedTemplate;
  }

  private async resolveFunctionValue(
    functionValue: FunctionValue,
    index: number,
    topLevelMappingProcessors: Record<string, MappingProcessor>,
    applyFiltering: boolean,
  ): Promise<any> {
    const returnValue = await this.executeFunctionFromValue(
      functionValue,
      index,
      topLevelMappingProcessors,
      applyFiltering,
    );
    return returnFirstItemInArrayOrValue(returnValue);
  }

  private async resolveTriplesMap(
    triplesMap: TriplesMap,
    topLevelMappingProcessors: Record<string, MappingProcessor>,
  ): Promise<any> {
    const processor = topLevelMappingProcessors[triplesMap['@id']!];
    if (processor) {
      if (processor.hasProcessed()) {
        return processor.getReturnValue();
      }
      return await processor.processMapping(topLevelMappingProcessors);
    }
    throw new Error('Could not resolve value of parentTriplesMap in function parameter');
  }

  private async executeFunction(
    functionName: string,
    parameters: Record<string | number, any>,
  ): Promise<any> {
    if (this.functions && functionName in this.functions) {
      return await this.functions[functionName](parameters);
    }
    if (functionName in predefinedFunctions) {
      return predefinedFunctions[functionName as keyof typeof predefinedFunctions](parameters);
    }
    throw new Error(`Could not find function ${functionName}`);
  }
}
