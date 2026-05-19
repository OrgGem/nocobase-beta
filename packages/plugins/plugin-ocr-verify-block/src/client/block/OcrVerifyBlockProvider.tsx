import { SchemaComponentOptions } from '@nocobase/client';
import React from 'react';
import { OcrVerifyBlock } from './OcrVerifyBlock';
import { OcrVerifyBlockInitializer } from './OcrVerifyBlockInitializer';

export const OcrVerifyBlockProvider = (props: any) => {
  return (
    <SchemaComponentOptions components={{ OcrVerifyBlock, OcrVerifyBlockInitializer }}>
      {props.children}
    </SchemaComponentOptions>
  );
};
