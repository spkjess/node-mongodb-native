import { Aspect, OperationBase, OperationOptions } from './operation';
import { ReadConcern } from '../read_concern';
import { WriteConcern, WriteConcernOptions } from '../write_concern';
import { maxWireVersion, MongoDBNamespace, Callback, decorateWithExplain } from '../utils';
import type { ReadPreference } from '../read_preference';
import { commandSupportsReadConcern } from '../sessions';
import { MongoError } from '../error';
import type { Logger } from '../logger';
import type { Server } from '../sdam/server';
import type { BSONSerializeOptions, Document } from '../bson';
import type { CollationOptions } from '../cmap/wire_protocol/write_command';
import type { ReadConcernLike } from './../read_concern';
import { Explain, ExplainOptions } from '../explain';

const SUPPORTS_WRITE_CONCERN_AND_COLLATION = 5;

/** @public */
export interface CommandOperationOptions
  extends OperationOptions,
    WriteConcernOptions,
    ExplainOptions {
  /** Return the full server response for the command */
  fullResponse?: boolean;
  /** Specify a read concern and level for the collection. (only MongoDB 3.2 or higher supported) */
  readConcern?: ReadConcernLike;
  /** Collation */
  collation?: CollationOptions;
  maxTimeMS?: number;
  /** A user-provided comment to attach to this command */
  comment?: string | Document;
  /** Should retry failed writes */
  retryWrites?: boolean;

  // Admin command overrides.
  dbName?: string;
  authdb?: string;
  noResponse?: boolean;
}

/** @public */
export interface OperationParent {
  s: { namespace: MongoDBNamespace };
  readConcern?: ReadConcern;
  writeConcern?: WriteConcern;
  readPreference?: ReadPreference;
  logger?: Logger;
  bsonOptions?: BSONSerializeOptions;
}

/** @internal */
export abstract class CommandOperation<
  T extends CommandOperationOptions = CommandOperationOptions,
  TResult = Document
> extends OperationBase<T> {
  ns: MongoDBNamespace;
  readConcern?: ReadConcern;
  writeConcern?: WriteConcern;
  explain?: Explain;
  fullResponse?: boolean;
  logger?: Logger;

  constructor(parent?: OperationParent, options?: T) {
    super(options);

    // NOTE: this was explicitly added for the add/remove user operations, it's likely
    //       something we'd want to reconsider. Perhaps those commands can use `Admin`
    //       as a parent?
    const dbNameOverride = options?.dbName || options?.authdb;
    if (dbNameOverride) {
      this.ns = new MongoDBNamespace(dbNameOverride, '$cmd');
    } else {
      this.ns = parent
        ? parent.s.namespace.withCollection('$cmd')
        : new MongoDBNamespace('admin', '$cmd');
    }

    this.readConcern = ReadConcern.fromOptions(options);
    this.writeConcern = WriteConcern.fromOptions(options);
    this.fullResponse =
      options && typeof options.fullResponse === 'boolean' ? options.fullResponse : false;

    // TODO(NODE-2056): make logger another "inheritable" property
    if (parent && parent.logger) {
      this.logger = parent.logger;
    }

    if (this.hasAspect(Aspect.EXPLAINABLE)) {
      this.explain = Explain.fromOptions(options);
    } else if (options?.explain !== undefined) {
      throw new MongoError(`explain is not supported on this command`);
    }
  }

  get canRetryWrite(): boolean {
    if (this.hasAspect(Aspect.EXPLAINABLE)) {
      return this.explain === undefined;
    }
    return true;
  }

  abstract execute(server: Server, callback: Callback<TResult>): void;

  executeCommand(server: Server, cmd: Document, callback: Callback): void {
    // TODO: consider making this a non-enumerable property
    this.server = server;

    const options = { ...this.options, ...this.bsonOptions };
    const serverWireVersion = maxWireVersion(server);
    const inTransaction = this.session && this.session.inTransaction();

    if (this.readConcern && commandSupportsReadConcern(cmd) && !inTransaction) {
      Object.assign(cmd, { readConcern: this.readConcern });
    }

    if (options.collation && serverWireVersion < SUPPORTS_WRITE_CONCERN_AND_COLLATION) {
      callback(
        new MongoError(
          `Server ${server.name}, which reports wire version ${serverWireVersion}, does not support collation`
        )
      );
      return;
    }

    if (serverWireVersion >= SUPPORTS_WRITE_CONCERN_AND_COLLATION) {
      if (this.writeConcern && this.hasAspect(Aspect.WRITE_OPERATION) && !inTransaction) {
        Object.assign(cmd, { writeConcern: this.writeConcern });
      }

      if (options.collation && typeof options.collation === 'object') {
        Object.assign(cmd, { collation: options.collation });
      }
    }

    if (typeof options.maxTimeMS === 'number') {
      cmd.maxTimeMS = options.maxTimeMS;
    }

    if (typeof options.comment === 'string') {
      cmd.comment = options.comment;
    }

    if (this.logger && this.logger.isDebug()) {
      this.logger.debug(`executing command ${JSON.stringify(cmd)} against ${this.ns}`);
    }

    if (this.hasAspect(Aspect.EXPLAINABLE) && this.explain) {
      if (serverWireVersion < 6 && cmd.aggregate) {
        // Prior to 3.6, with aggregate, verbosity is ignored, and we must pass in "explain: true"
        cmd.explain = true;
      } else {
        cmd = decorateWithExplain(cmd, this.explain);
      }
    }

    server.command(
      this.ns.toString(),
      cmd,
      { fullResult: !!this.fullResponse, ...this.options },
      callback
    );
  }
}